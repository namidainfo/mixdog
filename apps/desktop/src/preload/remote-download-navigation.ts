// A relay can still serve an older renderer. Keep worker-only downloads on
// the paired window's service worker instead of Chromium's download loader.
const WORKER_DOWNLOAD_PATH =
  /^\/__mixdog-download__\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function installRemoteDownloadNavigation(doc: Document): () => void {
  const view = doc.defaultView!;
  const onClick = (event: MouseEvent): void => {
    if (event.defaultPrevented || !(event.target instanceof view.Element)) return;
    const link = event.target.closest<HTMLAnchorElement>('a[download]');
    if (link?.origin === doc.location.origin && WORKER_DOWNLOAD_PATH.test(link.pathname)) {
      // The worker's Content-Disposition supplies the name after decryption.
      // Leave blob/data links and links to every other origin/path untouched.
      link.removeAttribute('download');
    }
  };
  doc.addEventListener('click', onClick, true);
  return () => doc.removeEventListener('click', onClick, true);
}
