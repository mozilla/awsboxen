AWSBoxen: Quick, Easy, Scalable Deployments atop AWS
====================================================

This is an experiment in easy automation of scalable app deployments into
the Amazon Web Services cloud.  It operates atop the powerful Amazon
CloudFormation framework [1]_, adding easy box-building capabilities and
some higher-level operating conveniences.

AWSBoxen is application-agnostic, but comes with some extra conveniences
for NodeJS apps due to being inspired by, and built upon, the awsbox [2]_  project.

.. [1] http://aws.amazon.com/cloudformation/
.. [2] http://awsbox.org/


Introduction
------------

AWSBoxen is a combination AMI-Generator and CloudFormation-Template-Preprocessor designed
to get your deployments up and running fast.  Here is the basic AWSBoxen process in a nutshell:

  0)  Store your code in git.  We assume you're working from a git checkout.
  1)  Create a file named ".awsboxen.json" at the top level of your project.
  2)  Use it to specify how your app should be run and what resources you want created.
  3)  Run "awsboxen deploy".
  4)  Relax as your app is effortlessly deployed to the cloud.


The ".awsboxen.json" file describes the entire structure of the deployment, using an extended version
of the CloudFormation template language.  It includes instructions on how to build AMIs for running
your code, and resource definitions to specify the infrastructure in which to deploy them.


Describing a Deployment
-----------------------

The structure of your AWS deployment is described using the AWS CloudFormation
language, with some shortcuts and helpers that make things a lot more convenient.
You must provide a file (usually named ".awsboxen.json") with a full description
of the desired deployment structure.  The two most important sections in this file
are

    Boxen
        Describes the different types of machine that will be present in
        the deployment, and how to build an AMI for each one.

    Resources
        Describes the cloud resources to be created, such as EC2
        instances, RDS databases, and Route53 DNS entries.

For a simple NodeJS application, the configuration file might look like this::

    {
      "Boxen": {
         "WebHead": {
           "Type": "AWSBox",
           "Properties": { "processes": [ "server.js "] }
         }
      }
    }

This specifies that there is a single type of machine in this deployment, and
that an AMI for it can be built by running `awsbox`_ with the given settings.

Since there are no physical resources specified in this file, AWSBoxen will
fill in some sensible defaults and produce a complete configuration that looks
something like this::

    {
      // Description automatically generated from repo name.

      "Description": "awsboxen deployment of example-server",

      // Enumerates the different types of boxen in this deployment.
      // Each entry will be used to produce an AMI that can then be
      // be referenced in the "Resources" section.
      //
      // In this case, we have only a single type of box.

      "Boxen": {
        "WebHead": {
          "Type": "AWSBox",
          "Properties": { "processes": [ "server.js "] }
        }
      },

      // Enumerates the physical resources that make up the deployment.
      // This might include a load balancer, a database instance, and some
      // EC2 instances running boxen that were defined above.
      //
      // In the default configuration, we get a single server instance and
      // a supporting security group.

      "Resources": {

        "WebHeadServer": {
          "Type": "AWS::EC2::Instance",
          "Properties": {
            "InstanceType": "m1.small",
            "ImageId": { "Ref": "WebHeadAMI" },
            "SecurityGroups": [{ Ref: 'AWSBoxSecurityGroup' }]
          }
        },

        "AWSBoxSecurityGroup": {
            ...security group guff elided...
        }

      }

    }


This is essentially a CloudFormation template with an extra section describing how to build different types of machine image.

The default setup should typically be enough to get started for small projects.  As your needs grow, you can fill in more
and more of the deployment description manually rather than relying on the defaults, using all the
powerful features of the `CloudFormation template language`_.

At deploy time, AWSBoxen will:

  * Build a machine as specified by each Boxen declaration, and freeze it into an AMI.
  * Use the generated AMI ids as CloudFormation template parameters.
  * Submit the CloudFormation resource description for creation in AWS.


For non-NodeJS applications, Boxen can be built by using a custom build script rather
than replying on awsbox.  This example includes one AMI built with awsbox and one built
using a custom build script::

    {
      "Boxen": {
        "WebHead": {
          // Boxen are assumed to be of type "AWSBox" by default
          // Their properties hash is the awsbox config.
          "Type": "AWSBox",
          "Properties": { "processes": [ "server.js "] }
        },
        "StorageNode" : {
          // This box will be built from a base AMI, using a custom script.
          // Script is located relative to root of project git repo.
          "Type":  "AWSBoxen::BuildScript",
          "Properties": {
            "BaseAMI": "ami-XXXXXX",
            "BuildScript": "scripts/build_storage_node.sh"
          }
      },
    }


Additional build mechanisms (e.g. puppet or chef) may be supported in the
future.

The CloudFormation template language can be pretty cumbersome, so we also offer some handy
shortcuts that make it more management.  You can use YAML instead of JSON, and if you provide a
directory instead of a file then it will be processed recursively, with each child entry forming
a correspondingly-named key in the generated JSON.  The above example could be produced from a directory
structure like this::

    .awsboxen/
        Description.yaml
        Resources.yaml
        Boxen/
           WebHead.json
        Profiles/
           Production.json


You can also create multiple deployment profiles (e.g. one for dev, one for
production) by populating the key "Profiles" with additional CloudFormation
configs.  A specific profile can be selected via command-line option when running
the awsboxen tool::

    {

      "Boxen": { "WebHead": { "processes": [ "server.js "] } },

      //  By default we use a small instance, for development purposes.

      "Resources": {
        "WebHead": {
          "Type": "AWS::EC2::Instance",
          "Properties": {
            "InstanceType": "m1.small",
            "ImageId": { "Ref": "WebHeadAMI" },
          }
        }
      },

      //  But we use a large instance when running in production.

      "Profiles" {
        "Production": {
          "Resources": { "WebHead": { "Properties": {
            "InstanceType": "m1.large"
          }}}
        }
      }
      
    }

The special profile name "Default" will be used if present when no explicit
profile has been specified on the command-line.



.. _awsbox: http://awsbox.org/
.. _CloudFormation template languate: http://docs.aws.amazon.com/AWSCloudFormation/latest/UserGuide/aws-template-resource-type-ref.html


Managing a Deployment
---------------------

All deployment managment is done through the "awsboxen" command-line client.
Here are the major modes of operation:


**awsboxen deploy [--profile=PROFILE] [--define=PARAM=VALUE,...] <name>**

This command lets you deploy a new version of your code into the cloud.  You
specify an optional deployment profile, and a unique name for this particular
deployment.

This command will:

  * Parse and load the .awsboxen.json file from the current directory.
  * Find all the declared boxen, and use awsbox to create an AMI for each
    with the appropriate version of the code.
  * Serialize the CloudFormation description and pass it up to AWS to
    create or update the deployment.
  * Wait until the deployment has completed, and report success or failure.

The same command works for creating a new deployment and updating an exsiting
deployment to a new code version.  Amazon CloudFormation has strong support
for making safe updates to an existing deployment, as described here:

  http://aws.amazon.com/about-aws/whats-new/2011/09/29/aws-cloudformation-new-features-update-stack-and-iam-support/

This approach allows you to version-control your evolving deployment stack
right alongside the actual code.  New version adds another type of server,
opens new network ports, and increases the size of the database?  No problem,
CloudFormation will take care of it with as little downtime as possible.
Want a staged rollout of new instances to your auto-scaling group?  No problem,
CloudFormation can do that for you.


**awsboxen freeze [--profile=PROFILE] [<box>...]**

Generate the frozen awsbox AMIs for all declared boxen, or for just the boxen
named on the command-line.  This may be useful if you want to use awsboxen
for development, then plug the AMIs into some other system for final production
deployent.


**awsboxen showconfig [--profile=PROFILE]**

This command will print the CloudFormation configuration as would be sent
up to AWS, along with the processed list of Boxen definitions.  It's very
useful for debugging our configuration.


**awsboxen validate [--profile=PROFILE]**

This command will build the CloudFormation configuration and send it to the
AWS servers for validation.  Any validation errors are logged to the console.


**awsboxen list**

This command will list the name of all current deployment stacks.


**awsboxen info <stack-name> [<resource-name>]**

With one argument, this command gets information about a current deployment
stack, including:

  * status of the stack
  * any "outputs" declared in the CloudFormation config
  * eventually this will report the deployed version of the code

With two arguments, this command gets information about a particular resource
within a stack.  Typically this would include its id status, public dns name,
and other type-specific information that may be useful.


**awsboxen teardown <name>**

This command destroys a deployment stack, deallocating all the corresponding
AWS resources.  It's very highly descructive and cannot be undone, so due
care should be taken!



AWS Access Credentials
----------------------

To access CloudFormation you will need to specify an AWS access key id and
matching secret key.  These can be provided in the command-line with the
`--aws-id` and `--aws-secret` options, or in the environment variables
`$AWS_ID` and `$AWS_SECRET`.

The deployment region can also be specified with either `--aws-region` or
`$AWS_REGION`.  It defaults to us-east-1.



Handling Secrets
----------------

Rather than putting secrets (e.g. database passwords) directly in the
cloudformation template, you should define them as parameters and specify
them on the command-line at deployment time.  For example, here is how an
RDS database instance might be declared with its password as a parameter::

    {
      "Parameters": {
        "DBPassword": {
          "Default": "plaintext_decoy_password",
          "Type": "String",
          "Description": "password to use for database access"
        }
      },

      "Resources": {
        "Database": {
          "Type" : "AWS::RDS::DBInstance",
          "Properties" : {
            "DBName": "mydatabase",
            "Engine": "MySQL",
            "MasterUsername": "myuser",
            "MasterUserPassword": {"Ref": "DBPassword"},
            "DBInstanceClass": "db.m1.small",
            "AllocatedStorage": "5"
          }
        }
      }
    }


At deployment time, the value of the password can be provided on the
command-line like so::

    $> awsboxen deploy -D DBPassword=MySecretPassword stack-name


If the number of parameters grows large, you can store them in a JSON-formatted
file for easy loading like so::

    $> echo '{"DBPassword": "MySecretPassword"}' > params.json
    $> 
    $> awsboxen deploy -F params.json stack-name
    [...deployment commences...]
    

You can even encrypt the file using gpg, and awsboxen will decrypt it on the
fly when deploying your stack, shelling out to gpg to prompt for the necessary
password::

    $> gpg --cipher-algo=aes256 --symmetric --armor params.json
    Enter passphrase:  ********
    Repeat passphrase:  ********
    $> 
    $> awsboxen deploy -F params.json.asc stack-name
    gpg: AES256 encrypted data
    Enter passphrase: ********
    gpg: encrypted with 1 passphrase
    [...deployment commences...]



Things To Do
------------

These are the things that don't work yet, in roughly the order I plan to
attempt working on them:

  * Controllable logging/verbosity so that you can get feedback during
    the execution of various commands.
  * Add a "deploy --dry-run" command which prints a summary of the changes
    that will be made, and highlights any potential downtime or destruction
    of existing resources.
  * Cleaning up of old AMIs, and related snapshots.
