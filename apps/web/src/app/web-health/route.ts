export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    status: 'ready',
    service: 'web',
    timestamp: new Date().toISOString(),
  });
}
