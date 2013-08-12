/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

const async = require('async');
const aws = require('awssum-amazon');
const Ec2 = require('awssum-amazon-ec2').Ec2;


module.exports = function getExtraInfo(opts, info, cb) {
  var ec2;
  try {
    ec2 = new Ec2({
      accessKeyId: opts.aws_id,
      secretAccessKey: opts.aws_secret,
      region: opts.aws_region
    });
  } catch (e) { return cb(e); }
  ec2.DescribeInstances({
    InstanceId: info.id
  }, function(err, res) {
    if (err) return cb(err);
    res = res.Body.DescribeInstancesResponse;
    res = res.reservationSet.item.instancesSet.item;
    info.ami = res.imageId;
    info.dnsname = res.dnsName;
    return cb(null, info);
  });
};
