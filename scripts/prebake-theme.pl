#!/usr/bin/perl
# prebake-theme.pl — inject FOUC-prevention theme-init snippet into <head> of every HTML page.
# Idempotent: skips files that already have the snippet.
use strict;
use warnings;
use File::Find;

my $marker  = 'kolm-theme';
my $snippet = qq{<script>(function(){try{var t=localStorage.getItem('kolm-theme');if(t==='light')document.documentElement.setAttribute('data-theme','light');}catch(e){}})();</script>\n};

my @files;
find(sub {
  return unless -f $_ && /\.html?$/i;
  return if $File::Find::name =~ m{/_archive/};
  push @files, $File::Find::name;
}, 'public');

my ($rewritten, $skipped) = (0, 0);
for my $f (@files) {
  open my $fh, '<:raw', $f or do { warn "open $f: $!\n"; next };
  local $/; my $html = <$fh>; close $fh;

  if ($html =~ /\Q$marker\E/) { $skipped++; next; }

  # Insert right after <meta name="color-scheme" ...> OR right after <head> tag (fallback).
  my $injected = 0;
  if ($html =~ s{(<meta\s+name="color-scheme"[^>]*>)}{$1\n$snippet}is) {
    $injected = 1;
  } elsif ($html =~ s{(<head[^>]*>)}{$1\n$snippet}is) {
    $injected = 1;
  }

  unless ($injected) { $skipped++; next; }

  # Also widen color-scheme to "dark light" if present (no-op if already widened).
  $html =~ s{<meta\s+name="color-scheme"\s+content="dark"\s*/?>}{<meta name="color-scheme" content="dark light">}ig;

  open my $out, '>:raw', $f or do { warn "write $f: $!\n"; next };
  print $out $html;
  close $out;
  $rewritten++;
}

print "rewritten: $rewritten\nskipped:    $skipped\n";
