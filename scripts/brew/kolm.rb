# Homebrew formula stub for kolm — the AI compiler.
# Status: PREVIEW (formula not yet on a tap; pending v0.1.0 GitHub release).
# To publish: `brew tap-new sneaky-hippo/kolm && cp this file there && brew audit --new kolm && git commit && git push`.
class Kolm < Formula
  desc "AI compiler — produce signed .kolm artifacts that run anywhere"
  homepage "https://kolm.ai"
  url "https://github.com/sneaky-hippo/kolmogorov-stack/archive/refs/tags/v0.1.0.tar.gz"
  # SHA256 to be set on first tagged release.
  sha256 "0000000000000000000000000000000000000000000000000000000000000000"
  license "MIT"
  head "https://github.com/sneaky-hippo/kolmogorov-stack.git", branch: "main"

  depends_on "node@22"

  def install
    system "npm", "install", "--production", *Language::Node.local_npm_install_args
    libexec.install Dir["*"]
    (bin/"kolm").write <<~EOS
      #!/bin/bash
      exec "#{Formula["node@22"].opt_bin}/node" "#{libexec}/cli/kolm.js" "$@"
    EOS
    chmod 0755, bin/"kolm"
  end

  test do
    assert_match "kolm v", shell_output("#{bin}/kolm --version")
    assert_match "compile", shell_output("#{bin}/kolm --help")
  end
end
