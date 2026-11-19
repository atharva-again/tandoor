import { isIP } from "node:net";

function isPrivateIpv4(hostname: string): boolean {
  const octets = hostname.split(".").map(Number);
  if (octets.length !== 4 || octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)) {
    return false;
  }
  const [first, second] = octets as [number, number, number, number];
  return (
    first === 0 ||
    first === 10 ||
    first === 127 ||
    (first === 169 && second === 254) ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168) ||
    (first === 100 && second >= 64 && second <= 127) ||
    (first === 198 && (second === 18 || second === 19)) ||
    first >= 224
  );
}

/** Accept public HTTP(S) destinations only; the provider performs the actual remote fetch. */
export function validatePublicWebUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("web_fetch requires a valid public HTTP or HTTPS URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("web_fetch only supports public HTTP and HTTPS URLs.");
  }
  if (url.username || url.password) {
    throw new Error("web_fetch does not accept URLs containing embedded credentials.");
  }

  const hostname = url.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  const localSuffixes = [".localhost", ".local", ".internal", ".home.arpa"];
  if (
    !hostname ||
    hostname === "localhost" ||
    localSuffixes.some((suffix) => hostname.endsWith(suffix)) ||
    (isIP(hostname) === 4 && isPrivateIpv4(hostname)) ||
    isIP(hostname) === 6
  ) {
    throw new Error("web_fetch only supports public web hosts; local or private-network URLs are blocked.");
  }

  url.hash = "";
  return url.toString();
}
