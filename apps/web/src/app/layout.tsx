import type { Metadata } from 'next';
import './styles.css';
import './qr-order.css';
export const metadata: Metadata = { title: 'OMNIHUB · Restaurant Operations', description: 'POS, kitchen and ingredient operations', manifest: '/manifest.webmanifest', appleWebApp: { capable: true, title: 'OMNIHUB KDS', statusBarStyle: 'default' } };
export default function Layout({ children }: { children: React.ReactNode }) { return <html lang="vi"><body>{children}</body></html>; }
