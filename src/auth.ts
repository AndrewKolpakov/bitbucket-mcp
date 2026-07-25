export interface AuthConfig {
  token?: string;
  username?: string;
  password?: string;
}

/**
 * Build the Authorization header for the Bitbucket client.
 *
 * Basic credentials MUST end up here, in a header, and never in axios's `auth`
 * option. Axios turns `auth` into Node's `options.auth`, and follow-redirects
 * does not replay that across a redirect — only headers survive the hop.
 * Bitbucket 302s the pull-request diff endpoints
 * (`/pullrequests/{id}/diffstat` -> `/repositories/{ws}/{slug}/diffstat/{spec}`),
 * so with `auth:` the followed request went out anonymous and came back
 * `404 You may not have access to this repository or it no longer exists in this
 * workspace` on a repo the caller can read fine. Verified against
 * api.bitbucket.org: `auth:` -> 404, this header -> 200.
 *
 * This does not leak credentials off-host: follow-redirects strips
 * `authorization` as soon as a redirect leaves the host (v1.15.9,
 * `!isSubdomain(redirectUrl.host, currentHost)`), so the header only ever
 * replays to Bitbucket itself.
 */
export function buildAuthHeaders(config: AuthConfig): Record<string, string> {
  if (config.token) {
    return { Authorization: `Bearer ${config.token}` };
  }
  if (config.username && config.password) {
    const basic = Buffer.from(`${config.username}:${config.password}`).toString(
      "base64"
    );
    return { Authorization: `Basic ${basic}` };
  }
  return {};
}
