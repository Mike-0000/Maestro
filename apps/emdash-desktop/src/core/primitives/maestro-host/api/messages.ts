/**
 * Connection issues of a Maestro host that the user resolves on the machine's page. The Host
 * supervisor reports them as the availability issue's message, so the renderer recognises the
 * one that calls for pairing again by this text.
 */
export const MAESTRO_HOST_NOT_PAIRED_MESSAGE =
  'This device is no longer paired with the host. Pair again.';

export const MAESTRO_HOST_CLOUDFLARE_MESSAGE =
  'Cloudflare Access rejected this device. Check the client ID and client secret for this host.';
