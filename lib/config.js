
const fs = require('fs');
const path = require('path');
const jsyaml = require('js-yaml');
const async = require('async');


const CONFIG_FILE_EXTENSIONS = [ '.json', '.yml', '.yaml' ];


//  Load config from the given file or directory.
//  YAML and JSON files are supported, while directories are processed
//  recursively with each child providing a key in the dict.
//
function loadConfig(configPath, cb) {
  fs.stat(configPath, function(err, stat) {
    if (err) return cb(err);
    if (stat.isDirectory()) {
      loadConfigFromDir(configPath, cb);
    } else {
      loadConfigFromFile(configPath, cb);
    }
  });
}


//  Given a file path, get the base name for the configuration section
//  loaded from that path.  The paths "Name/", "Name.json", "Name.yaml"
//  and "Name.yml" would all have base config name "Name".
//
//  If the given path is not recognisable as a config file then null
//  will be returned.
//
function getBaseConfigName(configPath, cb) {
  configPath = path.normalize(configPath);
  var ext = path.extname(configPath);
  if (CONFIG_FILE_EXTENSIONS.indexOf(ext) !== -1) {
    return cb(null, path.basename(configPath, ext));
  }
  fs.stat(configPath, function(err, stat) {
    if (err) return cb(err);
    if (stat.isDirectory()) return cb(null, path.basename(configPath, '/'));
    return cb(null, null);
  });
}


//  Load config from the given directory.
//  The result is a dict with each key corresponding to a file in the
//  directory, and each value corresponding to that file's contents.
//
function loadConfigFromDir(configPath, cb) {
  fs.readdir(configPath, function(err, names) {
    if (err) return cb(err);

    // Process items in a consistent order.
    // Useful if you have both Section.json and Section/Subsect.json.
    names.sort();

    // Independently load each sub-config from within the directory.
    // Fail out if any of them fail, otherwise merge them at the end.
    async.mapSeries(names, function(name, cb){

      var subConfigPath = path.join(configPath, name);
      getBaseConfigName(subConfigPath, function(err, key) {
        if (err) return cb(err);
        if (!key) return cb(null, {key: null});
        loadConfig(subConfigPath, function(err, subConfig) {
          if (err) return cb(err);
          return cb(null, {key: key, subConfig: subConfig});
        });
      });

    }, function(err, subConfigs) {
      if (err) return cb(err);

      var config = {};
      for (var i=0; i<names.length; i++) {
        var key = subConfigs[i].key;
        if (key) {
          config[key] = mergeConfig(config[key], subConfigs[i].subConfig);
        }
      }
      return cb(null, config);

    });
  });
}


//  Load config from the given directory.
//  YAML and JSON are supported.  We might add more formats in the future.
//
function loadConfigFromFile(configPath, cb) {
  var ext = path.extname(configPath);
  if (CONFIG_FILE_EXTENSIONS.indexOf(ext) === -1) {
    return cb('unrecognised config file type: ' + ext);
  }
  fs.readFile(configPath, function(err, data) {
    if (err) return cb(err);
    try {
      if (ext === '.yml' || ext === '.yaml') {
        cb(null, jsyaml.safeLoad(data.toString(), {strict: true}));
      } else {
        cb(null, JSON.parse(data));
      }
    } catch (err) {
      cb(err);
    }
  });
}


//  Merge one config into another config.
//  This recursively merges items of dicts and a few other clever
//  things, to give you a sensible combined result.
//
function mergeConfig(orig, incoming) {
  // Only objects can be sensibly merged.
  // For other types, the new value simply overrides the old.
  if (typeof(orig) !== 'object') return incoming;
  if (typeof(incoming) !== 'object') return incoming;

  for (var key in incoming) {
    if (incoming.hasOwnProperty(key)) {
      if (orig.hasOwnProperty(key)) {
        orig[key] = mergeConfig(orig[key], incoming[key]);
      } else {
        orig[key] = incoming[key];
      }
    }
  }
  return orig;
}


module.exports = {
  loadConfig: loadConfig,
  getBaseConfigName: getBaseConfigName,
  mergeConfig: mergeConfig
};
