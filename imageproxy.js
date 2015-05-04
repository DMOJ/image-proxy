#!/usr/bin/env node

var fs = require('fs');
var path = require('path');
var url = require('url');
var request = require('request');
var crypto = require('crypto');
var Datastore = require('nedb');

var argv = require('yargs')
  .demand(1).strict()
  .usage('Usage: imageproxy [options] <port>', {
    host: {
      default: '127.0.0.1',
      describe: 'address to listen on'
    },
    size: {
      default: 262144,
      type: 'int',
      describe: 'cache directory'
    },
    cache: {
      default: 'cache',
      describe: 'cache directory'
    },
    nginx: {
      default: null,
      describe: 'nginx X-Accel-Redirect internal location for cache directory'
    }
  }).argv;

var image_types = {
  'image/bmp': true,
  'image/x-windows-bmp': true,
  'image/gif': true,
  'image/x-icon': true,
  'image/jpeg': true,
  'image/pjpeg': true,
  'image/png': true,
  'image/tiff': true,
};

var cache_dir = argv.cache;
var size_cap = argv.size;
var typedb = new Datastore({ filename: path.join(cache_dir, 'types.db'), autoload: true});
var x_accel = argv.nginx;

function deliver_cache(res, name, type) {
  if (x_accel === null) {
    fs.readFile(path.join(cache_dir, name), function (err, data) {
      if (err) {
        res.writeHead(500, {'Content-Type': 'text/plain'});
        res.end(err.toString());
      } else {
        res.writeHead(200, {'Content-Type': type});
        res.end(data);
      }
    });
  } else {
    res.writeHead(200, {
      'Content-Type': type,
      'X-Accel-Redirect': x_accel + name
    });
    res.end();
  }
}

require('http').createServer(function (req, res) {
  var target = url.parse(req.url, true).query.url;
  if (!target) {
    res.writeHead(404, {'Content-Type': 'text/plain'});
    res.end('404 Not Found');
    return;
  }
  console.log(target);
  var hash = crypto.createHash('md5').update(target).digest('hex');
  var cache = path.join(cache_dir, hash);

  fs.exists(cache, function (exists) {
    if (exists) {
      typedb.findOne({ _id: hash }, function (err, doc) {
        console.log('Delivering:', hash, 'type:', doc.type);
        if (doc ===  null) {
          res.writeHead(500, {'Content-Type': 'text/plain'});
          res.end('Unknown type?');
        } else deliver_cache(res, hash, doc.type);
      });
      return;
    }

    request.get(target).on('response', function (proxy) {
      console.log('Got response: ' + proxy.statusCode);
      var size = parseInt(proxy.headers['content-length']);
      var known_size = !isNaN(size);
      var content_type = proxy.headers['content-type'];
      if (proxy.statusCode !== 200 || image_types[content_type] !== true ||
          known_size && size >= size_cap) {
        res.writeHead(301, {'Location': target});
        res.end('Redirecting to: ' + target);
        return;
      }

      var stream = fs.createWriteStream(cache);
      size = 0;
      proxy.on('data', function (data) {
        size += data.length;
        if (size >= size_cap) {
          res.writeHead(301, {'Location': target});
          res.end('Redirecting to: ' + target);
          proxy.pause();
          stream.end(function () {
            fs.unlink(cache);
          });
        }
        stream.write(data);
      }).on('end', function () {
        console.log('Caching:', hash, 'type:', content_type);
        typedb.update({_id: hash}, {_id: hash, type: content_type}, {upsert: true});
        deliver_cache(res, hash, content_type);
      });
    }).on('error', function (e) {
      res.writeHead(404, {'Content-Type': 'text/plain'});
      res.end('Error while downloading: ' + e.message);
    });
  });
}).listen(parseInt(argv._[0]), argv.host);