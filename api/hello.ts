/**
 * Simple test endpoint to verify Vercel function deployment
 */
import { toNodeHandler } from './_lib/node-adapter';

export const config = { runtime: 'nodejs' };
export const maxDuration = 10;

async function webHandler(req: Request): Promise<Response> {
  return new Response(JSON.stringify({
    success: true,
    message: 'API function is working!',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

export default toNodeHandler(webHandler);
