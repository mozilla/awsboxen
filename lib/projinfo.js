//
// Find info about a given project.
//
// This module is responsible for finding the info and configuration for
// a given project.  Currently this involved parsing the .awsboxen config
// file out of its root directory.  Eventually it'll grow more functionality
// for e.g. interrogating git for project metadata.

const config = require('./config');


// Make the module callable, returning a ProjectInfo object.
//
module.exports = function projinfo(projDir, profile, ref) {
  return new ProjectInfo(projDir, profile, ref);
};

module.exports.ProjectInfo = ProjectInfo;


//  Object representing a snapshot of the project to be deployed.
//  It encapsulates the git repo, selected profile, and selected git ref.
//
function ProjectInfo(projDir, profile, ref) {
  this.projDir = projDir;
  this.profile = profile || 'default';
  this.ref = ref;
}


// Load the (extended) CloudFormation config for this project.
// This method takes care of locating and parsing the config files,
// filling in the selected profile, providing sensible defaults, and
// returns the completed config object ready for use.
//
ProjectInfo.prototype.loadConfig = function loadConfig(cb) {
  var self = this;
  config.loadRootConfig(this.projDir, function(err, cfg) {
    if (err) return cb(err);
    // Merge the selected profile into the base configuration.
    // The special profile 'default' is assumed to be empty if not exists.
    var profileCfg = cfg.Profiles ? cfg.Profiles[self.profile] : null;
    if (!profileCfg) {
      if (self.profile !== 'default') {
        return cb('unknown profile "' + self.profile + '"');
      }
    } else {
      cfg = config.mergeConfig(cfg, profileCfg);
    }
    delete cfg.Profiles;
    return cb(null, cfg);
  });
};
