
const fs = require('fs');
const path = require('path');
const jsyaml = require('js-yaml');


const CONFIG_FILE_EXTENSIONS = [ '.json', '.yml', '.yaml' ];


//  Load config from the given file or directory.
//  YAML and JSON files are supported, while directories are processed
//  recursively with each child providing a key in the dict.
//
function loadConfig(configPath, cb) {
  fs.stat(path, function(err, stat) {
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
  var config = {};
  fs.readdir(configPath, function(err, names) {
    if (err) return cb(err);

    // Process items in a consistent order.
    // Useful if you have both Section.json and Section/Subsect.json.
    names.sort();

    // Load all sub-configs before trying to merge.
    // This makes it easier to report errors without callback hell.
    var subConfigs = [];
    names.forEach(function(name) {
      var subConfigPath = path.join(configPath, name);
      getBaseConfigName(subConfigPath, function(err, key) {
        if (err) {
          subConfigs.push({err: err});
        } else if (!key) {
          subConfigs.push({key: null});
        } else {
          loadConfig(subConfigPath, function(err, subConfig) {
            subConfigs.push({key: key, subConfig: subConfig});
          });
        }
      });
    });

    // Now merge all those sub-configs into the higher-level config.
    // This can be a synchronous loop, letting us bail on first error.
    for (var i=0; i<names.length; i++) {
      if (subConfigs[i].err) return cb(subConfigs[i].err);

      var key = subConfigs[i].key;
      if (key) {
        config[key] = mergeConfig(config[key], subConfigs[i].subConfig);
      }
    }
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
        cb(null, jsyaml.safeLoad(data, {strict: true}));
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
}


module.exports = {
  loadConfig: loadConfig,
  getBaseConfigName: getBaseConfigName,
  mergeConfig: mergeConfig
};
