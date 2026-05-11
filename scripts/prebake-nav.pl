#!/usr/bin/perl
# Pre-bake canonical 3-item nav into all site-header pages.
# Handles both header conventions:
#   A) <nav class="site-nav" aria-label="Primary">...7 links...</nav>
#   B) <nav>...7 links...</nav> (legacy inside <div class="left">)
use strict;
use warnings;
use File::Find;

my $changed = 0;
my $scanned = 0;
my $skipped = 0;

# Canonical 3-item replacements. nav.js will re-mark active state on load.
my $new_modern = <<'EOF';
<nav class="site-nav" aria-label="Primary">
      <a href="/use-cases">Solutions</a>
      <a href="/docs">Developers</a>
      <a href="/pricing">Pricing</a>
    </nav>
EOF
chomp $new_modern;

my $new_legacy = <<'EOF';
<nav>
        <a href="/use-cases">Solutions</a>
        <a href="/docs">Developers</a>
        <a href="/pricing">Pricing</a>
      </nav>
EOF
chomp $new_legacy;

sub process_file {
    return unless /\.html$/;
    my $path = $File::Find::name;
    $scanned++;

    open my $fh, '<', $_ or do { warn "open $path: $!"; return };
    local $/; my $content = <$fh>; close $fh;

    my $original = $content;

    # Convention A — modern site-nav with 7 links (allow optional class="active" on any link)
    $content =~ s{
        <nav\s+class="site-nav"\s+aria-label="Primary">\s*
            (?:<a\s+href="/compile"(?:\s+class="active")?>Compile</a>\s*)
            (?:<a\s+href="/serve"(?:\s+class="active")?>Serve</a>\s*)
            (?:<a\s+href="/evolve"(?:\s+class="active")?>Evolve</a>\s*)
            (?:<a\s+href="/anatomy"(?:\s+class="active")?>\.kolm</a>\s*)
            (?:<a\s+href="/k-score"(?:\s+class="active")?>K-score</a>\s*)
            (?:<a\s+href="/docs"(?:\s+class="active")?>Docs</a>\s*)
            (?:<a\s+href="/pricing"(?:\s+class="active")?>Pricing</a>\s*)
        </nav>
    }{$new_modern}sx;

    # Convention B — legacy bare <nav>
    $content =~ s{
        <nav>\s*
            (?:<a\s+href="/compile"(?:\s+class="active")?>Compile</a>\s*)
            (?:<a\s+href="/serve"(?:\s+class="active")?>Serve</a>\s*)
            (?:<a\s+href="/evolve"(?:\s+class="active")?>Evolve</a>\s*)
            (?:<a\s+href="/anatomy"(?:\s+class="active")?>\.kolm</a>\s*)
            (?:<a\s+href="/k-score"(?:\s+class="active")?>K-score</a>\s*)
            (?:<a\s+href="/docs"(?:\s+class="active")?>Docs</a>\s*)
            (?:<a\s+href="/pricing"(?:\s+class="active")?>Pricing</a>\s*)
        </nav>
    }{$new_legacy}sx;

    if ($content ne $original) {
        open my $out, '>', $_ or do { warn "write $path: $!"; return };
        print $out $content; close $out;
        $changed++;
        print "rewrote $path\n";
    } else {
        $skipped++;
    }
}

find({ wanted => \&process_file, no_chdir => 0 }, $ARGV[0] || 'public');
print "\nscanned: $scanned\nrewrote: $changed\nskipped: $skipped\n";
