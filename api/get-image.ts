// get-image.ts — 從 data/images/ 提供卡片圖片
import fs from 'fs';
import path from 'path';
import { toNodeHandler } from './_lib/node-adapter';

export const config = { runtime: 'nodejs' };

async function webHandler(req: Request) {
  try {
    const url = new URL(req.url);
    const filename = url.searchParams.get('file');

    if (!filename) {
      return new Response('Missing file param', { status: 400 });
    }

    // Security: prevent path traversal
    const safeName = path.basename(filename);
    if (!safeName) {
      return new Response('Invalid filename', { status: 400 });
    }

    const imagePath = path.resolve(process.cwd(), 'data/images', safeName);

    if (!fs.existsSync(imagePath)) {
      return new Response('Image not found', { status: 404 });
    }

    const imageBuffer = fs.readFileSync(imagePath);

    // Determine content type from extension
    const ext = path.extname(safeName).toLowerCase();
    const contentType: Record<string, string> = {
      '.jpg': 'image/jpeg',
      '.jpeg': 'image/jpeg',
      '.png': 'image/png',
      '.gif': 'image/gif',
      '.webp': 'image/webp',
    };

    return new Response(imageBuffer, {
      headers: {
        'Content-Type': contentType[ext] || 'image/jpeg',
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch (e: any) {
    return new Response(e.message || 'Error', { status: 500 });
  }
}

export default toNodeHandler(webHandler);
