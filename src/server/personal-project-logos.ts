/**
 * The personal building includes folders containing several apps. Pick their launcher artwork
 * explicitly instead of taking a random child repository's favicon. Paths stay inside the floor;
 * no machine-specific paths, shortcut execution, or copies of another project's artwork.
 */
const SOURCES: Record<string, readonly string[]> = {
  'personal-portfolio': [
    // The dashboard's sidebar mark is the requested identity for the whole portfolio floor.
    'personal-frontend/public/assets/site-logo.svg',
    'personal-frontend/public/logo512.png',
    'personal-frontend/.launcher/logo-256.png',
    'personal-frontend/.launcher/trading-dashboard.ico',
  ],
  'mft-trading-dashboard': [
    'dashboard-backend/.launcher/maple-futures.png',
    'dashboard-backend/.launcher/maple-futures.ico',
    'trading-dashboard/public/assets/galiot/galiot-icon-512.png',
    'trading-dashboard/public/favicon.svg',
  ],
  'agent-office': ['personal/windows/Agent Office.png', 'personal/windows/Agent Office.ico'],
  'paper-cloud': [
    '.launcher/paper-cloud-restored.ico',
    '.launcher/logo-256.png',
    '.launcher/paper-cloud.ico',
    'frontend/public/paper-cloud-logo.png',
    'frontend/src/app/icon.svg',
  ],
  'dad-projects': [
    'bmo-frontend/public/bmo-launcher.ico',
    'bmo-portfolio-frontend/public/bmo-launcher.ico',
    'bmo-frontend/public/assets/site-logo.svg',
  ],
  'database-app': [
    'database-app/public/icons/icon-512.png',
    'database-app/public/favicon.ico',
    'public/icons/icon-512.png',
  ],
  'autonomous-dev-projects': ['morning-brief/morning-brief.ico'],
  'trace': ['tools/trace.ico', 'ui/public/trace-icon.svg', 'ui/public/trace-icon.png'],
  'dock': ['assets/dock.ico', 'public/icon.svg', 'public/icon-512.png'],
};

export function personalProjectLogoPaths(project: string): readonly string[] {
  const key = project.toLowerCase().replace(/[\s_]+/g, '-');
  return Object.hasOwn(SOURCES, key) ? SOURCES[key] : [];
}
