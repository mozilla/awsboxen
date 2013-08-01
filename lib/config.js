/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

/*
 * Config file reader.
 *
 * This module implements reading of config files, applying some handy
 * shortcuts that can make writing large configs a bit simpler.  It can
 * load from JSON or YAML files directly, and can merge directory trees of
 * such files into a single configuration dict.
 *
 */

const fs = require('fs');
const path = require('path');
const jsyaml = require('js-yaml');
const async = require('async');


const CONFIG_FILE_EXTENSIONS = [ '.json', '.yml', '.yaml' ];


module.exports = {
  loadRootConfig: loadRootConfig,
  loadConfig: loadConfig,
  mergeConfig: mergeConfig,
  getBaseConfigName: getBaseConfigName
};


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
    var configPaths = [];
    names.forEach(function(name) {
      configPaths.push(path.join(configPath, name));
    });
    // Process items in a consistent order.
    configPaths.sort();
    loadConfigFromSiblings(configPaths, cb);
  });
}


//  Load a merged config from sibling files/directories.
//  This logic is common to loadConfigFromDir and loadRootConfig.
//
function loadConfigFromSiblings(configPaths, cb) {
  // Independently load each sub-config.
  // Fail out if any of them fail, otherwise merge them at the end.
  async.mapSeries(configPaths, function(configPath, cb){
    getBaseConfigName(configPath, function(err, key) {
      if (err) return cb(err);
      if (!key) return cb(null, {key: null});
      loadConfig(configPath, function(err, subConfig) {
        if (err) return cb(err);
        // Don't merge it if it didn't produce any keys.
        // This prevents us creating bogus keys for e.g. empty dirs.
        for (var k in subConfig) {
          if (subConfig.hasOwnProperty(k)) {
            return cb(null, {key: key, subConfig: subConfig});
          }
        }
        return cb(null, {key: null});
      });
    });
  }, function(err, subConfigs) {
    if (err) return cb(err);
    var config = {};
    subConfigs.forEach(function(res) {
      if (res.key) {
        config[res.key] = mergeConfig(config[res.key], res.subConfig);
      }
    });
    return cb(null, config);
  });
}


//  Load config from the given file.
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
  if (incoming === null || typeof(incoming) !== 'object') return incoming;
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


//  Load root config file for awsboxen.
//
//  When given a single path name as argument, this looks for files name
//  ".awsboxen.json", ".awsboxen.yaml", etc and reads any it can find,
//  merging the results into the final config.  When given an array of
//  paths these are treated as the root set of config files to load.
//
//  The default list of base file names searched in a directory are:
//
//     - awsboxen.*
//     - .awsboxen.*
//     - .awsbox.*
//
//  This can be changed by passing the optional baseNames argument.
// 
function loadRootConfig(configDirOrPaths, baseNames, cb) {
  if (typeof(baseNames) === 'function') {
    cb = baseNames;
    baseNames = null;
  }
  if (!baseNames) {
    baseNames = ["awsboxen", ".awsboxen", ".awsbox"];
  }

  var configPaths = [];
  async.waterfall([

    function searchForConfigPaths(cb) {
      // If we already have a list of paths, just use that directly.
      if (typeof configDirOrPaths !== "string") {
        configPaths = configDirOrPaths;
        return cb(null);
      }
      // Otherwise, search for config files/dirs in the given project dir.
      fs.readdir(configDirOrPaths, function(err, names) {
        if (err) return cb(err);
        names.forEach(function(name) {
          var ext = path.extname(name);
          var base = path.basename(name, ext);
          if (baseNames.indexOf(base) !== -1) {
            
            configPaths.push(path.join(configDirOrPaths, name));
          }
        });
        if (configPaths.length === 0) {
          return cb('no ' + baseNames + ' config files found');
        }
        // Always process them in a consistent order.
        configPaths.sort();
        return cb(null);
      });
    },

    function loadAndMergeConfigPaths(cb) {
      // Load them as siblings, then merge them all together
      // into one big config hash.
      loadConfigFromSiblings(configPaths, function(err, subConfigs) {
        if (err) return cb(err);
        var config = {};
        Object.keys(subConfigs).sort().forEach(function(k) {
          config = mergeConfig(config, subConfigs[k]);
        });
        return cb(null, config);
      });
    }

  ], cb);
}
