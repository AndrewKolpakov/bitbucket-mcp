import { buildAuthHeaders } from "../src/auth.js";

describe("buildAuthHeaders", () => {
  it("encodes username/password as a Basic header", () => {
    // The header form is the whole point: axios's `auth` option becomes Node's
    // options.auth, which follow-redirects drops on Bitbucket's diffstat 302 —
    // the followed request then 404s as if the repo did not exist.
    expect(buildAuthHeaders({ username: "user", password: "pw" })).toEqual({
      Authorization: `Basic ${Buffer.from("user:pw").toString("base64")}`,
    });
  });

  it("prefers a bearer token over basic credentials", () => {
    expect(
      buildAuthHeaders({ token: "t0ken", username: "user", password: "pw" })
    ).toEqual({ Authorization: "Bearer t0ken" });
  });

  it("returns no header when credentials are incomplete", () => {
    expect(buildAuthHeaders({ username: "user" })).toEqual({});
    expect(buildAuthHeaders({ password: "pw" })).toEqual({});
    expect(buildAuthHeaders({})).toEqual({});
  });
});
