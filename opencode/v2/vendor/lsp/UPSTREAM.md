# Vendored LSP bridge

Source: https://github.com/christensenjairus/opencode-v2-lsp-support

Pinned commit: `4a17bc8379e572ab104ec26b55f92ee9b51dce37` (MIT; see LICENSE).

The source, entrypoint and tests are unchanged. ThreadSite's `v2/lsp.ts` uses the
manager, tool and diagnostic hook directly, with harness-supplied settings instead
of discovering server commands in generated project configuration. The upstream
entrypoint/config reader are retained for running its regression suite.

After updating, run the upstream suite under Node 24 with this directory's absolute
path as its argument, the ThreadSite runtime tests, and the native v2 smoke test
with the real language servers in the service image.
