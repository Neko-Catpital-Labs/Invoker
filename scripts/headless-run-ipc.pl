#!/usr/bin/env perl
use strict;
use warnings;
use Cwd qw(abs_path);
use File::Spec;
use IO::Socket::UNIX;
use JSON::PP qw(encode_json decode_json);

my $fallback_code = 86;

sub usage {
  print STDERR "Usage: headless-run-ipc.pl --no-track run <plan.yaml>\n";
  exit 2;
}

sub invoker_home {
  return $ENV{INVOKER_DB_DIR} if defined $ENV{INVOKER_DB_DIR} && length $ENV{INVOKER_DB_DIR};
  return File::Spec->catdir($ENV{HOME} || '.', '.invoker');
}

sub socket_path {
  return $ENV{INVOKER_IPC_SOCKET} if defined $ENV{INVOKER_IPC_SOCKET} && length $ENV{INVOKER_IPC_SOCKET};
  return File::Spec->catfile(invoker_home(), 'ipc-transport.sock');
}

sub read_exact {
  my ($socket, $length) = @_;
  my $buffer = '';
  while (length($buffer) < $length) {
    my $chunk = '';
    my $read = sysread($socket, $chunk, $length - length($buffer));
    die "IPC socket closed before response\n" unless defined($read) && $read > 0;
    $buffer .= $chunk;
  }
  return $buffer;
}

sub send_plan {
  my ($plan_path, $quiet) = @_;
  my $socket_path = socket_path();
  my $socket = IO::Socket::UNIX->new(Type => SOCK_STREAM, Peer => $socket_path);
  return $fallback_code unless $socket;

  my $req_id = "$$-".time()."-".int(rand(1_000_000));
  my $trace_id = "headless.run:$$:".time().":".int(rand(1_000_000));
  my $json = encode_json({
    kind => 'req',
    channel => 'headless.run',
    reqId => $req_id,
    body => {
      planPath => $plan_path,
      traceId => $trace_id,
      noTrack => JSON::PP::true,
      ackOnly => JSON::PP::true,
    },
  });

  print {$socket} pack('N', length($json)), $json;

  my $payload;
  while (1) {
    my $header = read_exact($socket, 4);
    my $length = unpack('N', $header);
    my $candidate = decode_json(read_exact($socket, $length));
    next unless (($candidate->{kind} || '') eq 'res' || ($candidate->{kind} || '') eq 'err');
    next unless (($candidate->{reqId} || '') eq $req_id);
    $payload = $candidate;
    last;
  }

  if (($payload->{kind} || '') eq 'err') {
    return $fallback_code if ($payload->{code} || '') eq 'NO_HANDLER';
    print STDERR (($payload->{message} || 'headless.run failed')."\n");
    return 1;
  }

  my $workflow_id = $payload->{body}->{workflowId};
  my $ok = $payload->{body}->{ok};
  if ((!defined($workflow_id) || $workflow_id !~ /^wf-/) && !$ok) {
    print STDERR "headless.run returned no workflowId\n";
    return 1;
  }

  if (!$quiet) {
    if (defined($workflow_id) && $workflow_id =~ /^wf-/) {
      print "Delegated to owner — workflow: $workflow_id\n";
    } else {
      print "Delegated to owner\n";
    }
    print "--no-track enabled: delegated submission accepted; exiting without tracking.\n";
  }
  return 0;
}

if (@ARGV >= 2 && $ARGV[0] eq '--drain-queue') {
  my ($queue_dir, $lock_dir) = @ARGV[1, 2];
  my $idle_deadline = time() + 2;
  while (time() <= $idle_deadline) {
    my @items = sort glob("$queue_dir/*.item");
    if (!@items) {
      select(undef, undef, undef, 0.05);
      next;
    }
    $idle_deadline = time() + 2;
    for my $item (@items) {
      open(my $fh, '<', $item) or next;
      my $plan_path = <$fh>;
      close($fh);
      chomp($plan_path) if defined $plan_path;
      if (defined $plan_path && length $plan_path) {
        my $status = send_plan($plan_path, 1);
        print STDERR "queued headless.run failed for $plan_path status=$status\n" if $status != 0;
      }
      unlink $item;
    }
  }
  if (defined $lock_dir && length $lock_dir) {
    if (-d $lock_dir) {
      rmdir $lock_dir;
    } else {
      unlink $lock_dir;
    }
  }
  exit 0;
}

my @args = @ARGV;
my $no_track_index = -1;
for my $i (0 .. $#args) {
  if ($args[$i] eq '--no-track' || $args[$i] eq '--do-not-track') {
    $no_track_index = $i;
    last;
  }
}
usage() if $no_track_index < 0;
splice(@args, $no_track_index, 1);
usage() unless @args == 2 && $args[0] eq 'run';

my $plan_path = abs_path($args[1]) || $args[1];
exit send_plan($plan_path, 0);
