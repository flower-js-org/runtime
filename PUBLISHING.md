# Publishing the handbook

The public repository is [flower-js-org/runtime](https://github.com/flower-js-org/runtime). The static site is the `docs/` directory; it needs no build step or external assets. GitHub Pages serves it at [flower-js-org.github.io/runtime/](https://flower-js-org.github.io/runtime/) until the custom domain is activated.

The `Publish handbook` workflow uploads only `docs/` and deploys it to the `github-pages` environment when documentation changes reach the default branch. It can also be run manually. In repository **Settings → Pages**, select **GitHub Actions** as the publishing source.

## flower.js.org

`docs/CNAME` contains exactly `flower.js.org`. This file declares the intended custom domain and also supports branch-based Pages publishing. With an Actions publishing source, GitHub requires the custom domain to be set in repository settings or through its API; the artifact's CNAME file does not configure that setting by itself. [GitHub's custom-domain instructions](https://docs.github.com/en/pages/configuring-a-custom-domain-for-your-github-pages-site/managing-a-custom-domain-for-your-github-pages-site)

The JS.ORG registry needs a `flower` entry targeting `flower-js-org.github.io`. The DNS target is the account's Pages hostname, without the repository path. Follow [JS.ORG's request process](https://github.com/js-org/js.org#requesting-a-jsorg-subdomain); adding the local CNAME file does not register DNS or obtain approval.

After the domain is allocated, set **Settings → Pages → Custom domain** to `flower.js.org`, allow GitHub's DNS check and certificate provisioning to finish, and enable **Enforce HTTPS**. This changes routing for the project site to `https://flower.js.org/`. The published HTML already uses that canonical URL, while relative assets work at either host.

The initial publication uses the working default Pages URL while the JS.ORG DNS entry is absent. No DNS request has been submitted by this workflow.
