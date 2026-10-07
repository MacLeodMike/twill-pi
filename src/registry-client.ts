// Registry HTTP client (T2b) — thin fetch wrappers over the twill
// registry's v1alpha1 surface (workspace §8 + core §9). The adapter is a
// pure HTTP consumer: it imports nothing from the twill repo and shares
// the exact contract the `twill` CLI exercises.
//
// Surface consumed:
//   POST   /resolve                          {kind, name, consumer} → ResolveResult
//   GET    /<kind>/<name>                    → the verbatim document envelope
//   POST   /Claim/<name>                     → 201 with the created envelope
//   GET    /claims?parent=<kind>/<name>[&includeReleased=true]
//   PATCH  /Claim/<name>                     → release (the T2a CLI pattern:
//                                              parent-scoped read, flip
//                                              spec.claim.released, send back)
//
// Every wrapper returns the parsed JSON body verbatim; a non-2xx answer
// throws RegistryError carrying the server's error body (the registry's
// error shape is {"error": string}).

/** The core §7.1 consumer tuple (self-declared, untrusted per core §5). */
export interface Consumer {
  agentLocation: string;
  agentKind: string;
  principal: string;
}

/** A non-2xx registry answer: the HTTP status plus the server's error body. */
export class RegistryError extends Error {
  readonly httpStatus: number;
  /** The server's parsed error body ({"error": string} on the v1alpha1 surface). */
  readonly serverBody: unknown;
  constructor(httpStatus: number, serverBody: unknown) {
    const detail =
      isRecord(serverBody) && typeof serverBody["error"] === "string"
        ? serverBody["error"]
        : serverBody === undefined
          ? "(no body)"
          : JSON.stringify(serverBody);
    super(`registry answered HTTP ${httpStatus}: ${detail}`);
    this.name = "RegistryError";
    this.httpStatus = httpStatus;
    this.serverBody = serverBody;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The registry's health report (workspace §8's GET /health surface):
 * documentSet current/stale plus the warnings array; rejectedAt/reason are
 * present only on a stale set.
 */
export interface RegistryHealth {
  documentSet: string;
  warnings: unknown[];
  rejectedAt?: string;
  reason?: string;
}

/** Read a response body as JSON; undefined when the body isn't JSON. */
async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Parse the response as JSON, throwing RegistryError on a non-2xx answer. */
async function parseOrThrow(res: Response): Promise<unknown> {
  const body = await readJson(res);
  if (!res.ok) throw new RegistryError(res.status, body);
  return body;
}

/**
 * Thin HTTP consumer of the twill registry. The base URL is the
 * /twill/v1alpha1 root (config.registry); trailing slashes are stripped.
 */
export class RegistryClient {
  private readonly base: string;

  constructor(registry: string) {
    this.base = registry.replace(/\/+$/, "");
  }

  /**
   * core §7: POST /resolve with {kind, name, consumer}. The three result
   * shapes (Attached with descriptor / NoMatch / Unreachable with errors)
   * are returned verbatim as parsed JSON — the adapter does not interpret
   * them here (the kind packages' tools do).
   */
  async resolve(kind: string, name: string, consumer: Consumer): Promise<unknown> {
    const res = await fetch(`${this.base}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ kind, name, consumer }),
    });
    return parseOrThrow(res);
  }

  /**
   * GET /health — the registry's HealthReport, validated minimally
   * (documentSet string + warnings array); a malformed body throws (the
   * registry violated the contract).
   */
  async health(): Promise<RegistryHealth> {
    const res = await fetch(`${this.base}/health`);
    const body = await parseOrThrow(res);
    if (!isRecord(body) || typeof body["documentSet"] !== "string" || !Array.isArray(body["warnings"])) {
      throw new Error(`malformed health report: ${JSON.stringify(body)}`);
    }
    const health: RegistryHealth = { documentSet: body["documentSet"], warnings: body["warnings"] };
    if (typeof body["rejectedAt"] === "string") health.rejectedAt = body["rejectedAt"];
    if (typeof body["reason"] === "string") health.reason = body["reason"];
    return health;
  }

  /** GET /<kind>/<name> — the verbatim stored document envelope. */
  async getDoc(kind: string, name: string): Promise<unknown> {
    const res = await fetch(`${this.base}/${encodeURIComponent(kind)}/${encodeURIComponent(name)}`);
    return parseOrThrow(res);
  }

  /** POST /Claim/<name> — create the claim (core §9's document shape). */
  async createClaim(name: string, claimDoc: Record<string, unknown>): Promise<unknown> {
    const res = await fetch(`${this.base}/Claim/${encodeURIComponent(name)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(claimDoc),
    });
    return parseOrThrow(res);
  }

  /** GET /claims?parent=<kind>/<name> — claim envelopes against one parent. */
  async listClaims(
    parentKind: string,
    parentName: string,
    options: { includeReleased?: boolean } = {},
  ): Promise<Array<Record<string, unknown>>> {
    const parent = encodeURIComponent(`${parentKind}/${parentName}`);
    const suffix = options.includeReleased === true ? "&includeReleased=true" : "";
    const res = await fetch(`${this.base}/claims?parent=${parent}${suffix}`);
    const body = await parseOrThrow(res);
    if (!Array.isArray(body)) {
      throw new Error(`registry answered claims with a non-array body: ${JSON.stringify(body)}`);
    }
    return body as Array<Record<string, unknown>>;
  }

  /**
   * Release a claim, the T2a CLI pattern: v1alpha1 has no single-claim read
   * (GET /Claim/<name> is 501), so the stored envelope comes from the
   * parent-scoped read path with includeReleased=true; the PATCH sends it
   * back with only spec.claim.released flipped true (release is the only
   * permitted mutation — workspace §8).
   */
  async releaseClaim(parentKind: string, parentName: string, claimName: string): Promise<unknown> {
    const claims = await this.listClaims(parentKind, parentName, { includeReleased: true });
    const stored = claims.find(
      (claim) => isRecord(claim["metadata"]) && claim["metadata"]["name"] === claimName,
    );
    if (stored === undefined) {
      throw new Error(`no such claim: Claim/${claimName} against ${parentKind}/${parentName}`);
    }
    const released = JSON.parse(JSON.stringify(stored)) as Record<string, unknown>;
    const spec = isRecord(released["spec"]) ? released["spec"] : undefined;
    const claim = spec !== undefined && isRecord(spec["claim"]) ? spec["claim"] : undefined;
    if (spec === undefined || claim === undefined) {
      throw new Error(`stored claim ${claimName} carries no spec.claim (not a well-formed claim envelope)`);
    }
    claim["released"] = true;
    const res = await fetch(`${this.base}/Claim/${encodeURIComponent(claimName)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(released),
    });
    return parseOrThrow(res);
  }
}
