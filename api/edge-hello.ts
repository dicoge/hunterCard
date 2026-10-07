/**
 * Edge-runtime probe for DIC-1037: does the Vercel Edge runtime execute on
 * this project while Node functions hang?
 */
export const config = { runtime: 'edge' };

export default function handler(req: Request): Response {
  return new Response(JSON.stringify({
    success: true,
    message: 'Edge API function is working!',
    runtime: 'edge',
  }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
