// Minimal Azure Blob REST client for the Maestro update feed: Put Blob / Get Properties with a SAS
// token. Uses plain HTTPS so publishing needs no Azure SDK or CLI. Never log request URLs: upload
// URLs carry the SAS token.

const API_VERSION = '2021-08-06';

export interface BlobProperties {
  size: number;
  sha512: string | null;
}

export interface PutBlobOptions {
  contentType: string;
  cacheControl: string;
  /** Refuse to replace an existing blob (Azure answers 409 BlobAlreadyExists). */
  createOnly: boolean;
  sha512?: string;
}

function describeFailure(action: string, response: Response, body: string): Error {
  const code = response.headers.get('x-ms-error-code') ?? response.statusText;
  const hint =
    response.status === 403
      ? ' Check that the SAS token is valid, unexpired, and grants create + write on the container.'
      : '';
  return new Error(
    `${action} failed: HTTP ${response.status} (${code}).${hint} ${body.slice(0, 300)}`
  );
}

export async function putBlob(
  url: string,
  body: Uint8Array,
  options: PutBlobOptions,
  label: string
): Promise<void> {
  const headers: Record<string, string> = {
    'x-ms-version': API_VERSION,
    'x-ms-blob-type': 'BlockBlob',
    'x-ms-blob-content-type': options.contentType,
    'x-ms-blob-cache-control': options.cacheControl,
    'Content-Type': options.contentType,
  };
  if (options.createOnly) headers['If-None-Match'] = '*';
  if (options.sha512) headers['x-ms-meta-sha512'] = options.sha512;
  const response = await fetch(url, { method: 'PUT', headers, body });
  if (response.status !== 201) {
    throw describeFailure(`Uploading ${label}`, response, await response.text());
  }
}

/** Blob size and recorded SHA-512 metadata, or null when the blob does not exist. */
export async function getBlobProperties(
  url: string,
  label: string
): Promise<BlobProperties | null> {
  const response = await fetch(url, { method: 'HEAD', headers: { 'x-ms-version': API_VERSION } });
  if (response.status === 404) return null;
  if (!response.ok) throw describeFailure(`Reading ${label}`, response, '');
  return {
    size: Number(response.headers.get('content-length')),
    sha512: response.headers.get('x-ms-meta-sha512'),
  };
}

/** Fetch a text blob, or null when it does not exist. Works anonymously on a public container. */
export async function getBlobText(url: string, label: string): Promise<string | null> {
  const response = await fetch(url, { headers: { 'Cache-Control': 'no-cache' } });
  if (response.status === 404) return null;
  const body = await response.text();
  if (!response.ok) throw describeFailure(`Reading ${label}`, response, body);
  return body;
}
