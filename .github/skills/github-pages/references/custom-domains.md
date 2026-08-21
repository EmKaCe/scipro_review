# Custom Domains for GitHub Pages

Configure a custom domain for a SvelteKit SPA deployed to GitHub Pages via GitHub Actions.

## Supported Domain Types

| Type | Example | DNS Record | Stability |
|------|---------|------------|-----------|
| `www` subdomain | `www.example.com` | CNAME | Most stable — unaffected by GitHub IP changes |
| Custom subdomain | `blog.example.com` | CNAME | Stable |
| Apex domain | `example.com` | A / ALIAS / ANAME | Less stable — tied to GitHub IP addresses |

**Recommendation**: Use a `www` subdomain. It's the most stable because it uses CNAME, which isn't affected by GitHub server IP changes. If you also want the apex domain, configure both — GitHub Pages auto-redirects between them.

## Procedure: Configure a Custom Domain

### 1. Add domain in GitHub Settings

1. Go to repo **Settings → Pages**
2. Under "Custom domain", type the domain and click **Save**

> **Important**: When publishing via GitHub Actions, no `CNAME` file is created in the repo. The domain is stored in GitHub's settings. Do NOT add a `CNAME` file to `static/` — it will be ignored.

### 2. Configure DNS records

#### For a subdomain (e.g., `www.example.com`)

Create a **CNAME** record:

| Field | Value |
|-------|-------|
| Name | `www` (or your subdomain) |
| Value | `<username>.github.io` |

The CNAME must point to `<username>.github.io` (or `<org>.github.io`), **without** the repository name.

#### For an apex domain (e.g., `example.com`)

Create **A** records (all four required):

| Name | Type | Value |
|------|------|-------|
| `@` | A | `185.199.108.153` |
| `@` | A | `185.199.109.153` |
| `@` | A | `185.199.110.153` |
| `@` | A | `185.199.111.153` |

Optionally add **AAAA** records for IPv6:

| Name | Type | Value |
|------|------|-------|
| `@` | AAAA | `2606:50c0:8000::153` |
| `@` | AAAA | `2606:50c0:8001::153` |
| `@` | AAAA | `2606:50c0:8002::153` |
| `@` | AAAA | `2606:50c0:8003::153` |

Alternatively, use a single **ALIAS** or **ANAME** record pointing to `<username>.github.io`.

#### For apex + www (recommended)

1. Configure the apex domain A records (above)
2. Add a CNAME for `www` pointing to `<username>.github.io`
3. GitHub Pages will auto-redirect between the two

### 3. Verify DNS propagation

```sh
# Check subdomain CNAME
dig www.example.com +nostats +nocomments +nocmd

# Check apex A records
dig example.com +noall +answer -t A
```

DNS changes can take up to **24 hours** to propagate.

### 4. Enforce HTTPS

After DNS propagates, go to repo **Settings → Pages** and enable **Enforce HTTPS**. This option may take up to 24 hours to appear after domain configuration.

### 5. Verify domain ownership (recommended)

Verify your domain in GitHub to prevent takeover attacks:

1. Go to your GitHub account **Settings → Pages**
2. Add the domain and follow the verification steps (adds a TXT record to DNS)

## Gotchas

- **Add domain to GitHub BEFORE configuring DNS**: If you configure DNS first without adding the domain in GitHub, someone else could host a site on your subdomain.
- **Never use wildcard DNS records** (`*.example.com`): These create an immediate domain takeover risk, even with domain verification.
- **CNAME must point to `<user>.github.io`**, not `<user>.github.io/repo-name`: Including the repo name breaks the DNS resolution.
- **Remove default DNS records**: Some DNS providers auto-set default records. Remove them before adding GitHub Pages records.
- **Custom domain across repos**: If you set a custom domain on a user/org site, all project sites under that account default to the same domain (e.g., `www.example.com/repo-name`). Override per-repo by adding a custom domain to individual repos.
- **Domain takeover risk**: If your GitHub Pages site is disabled (e.g., downgrading to Free plan) while DNS still points to GitHub, someone else could claim your subdomain. Verify your domain to mitigate this.
- **Internationalized domain names**: Must be entered in Punycode format in GitHub settings.

## Removing a Custom Domain

1. Go to repo **Settings → Pages**
2. Under "Custom domain", click **Remove**
3. Update or remove DNS records with your provider