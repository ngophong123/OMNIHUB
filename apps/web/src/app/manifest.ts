import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'OMNIHUB Kitchen Display', short_name: 'OMNIHUB KDS', description: 'Offline-capable restaurant kitchen display',
    start_url: '/', scope: '/', display: 'standalone', background_color: '#f6f7f2', theme_color: '#185c48',
    icons: [{ src: '/pwa-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' }],
  };
}
