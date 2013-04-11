
const config = require('./config');


module.exports = function projinfo(projDir, profile, ref) {
  return new ProjectInfo(projDir, profile, ref);
};


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
    // Delete any other unused profiles, to avoid clutter.
    delete cfg.Profiles;
    return cb(null, cfg);
  });
};
