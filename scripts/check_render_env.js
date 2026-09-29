const RENDER_API_KEY = 'rnd_xfxmD9gW1Rf9g2HEW9AI9Ps4UhnW';
const SERVICE_ID = 'srv-dasuvcd9fdbs73f80ckg';

async function main() {
  console.log('--- Services on Render Account ---');
  const resServices = await fetch('https://api.render.com/v1/services?limit=20', {
    headers: { 'Authorization': `Bearer ${RENDER_API_KEY}` }
  });
  const services = await resServices.json();
  console.log('Services:', services.map(s => ({ id: s.service?.id, name: s.service?.name, repo: s.service?.repo, type: s.service?.type })));

  console.log('\n--- Env vars for service ' + SERVICE_ID + ' ---');
  const resEnv = await fetch(`https://api.render.com/v1/services/${SERVICE_ID}/env-vars?limit=50`, {
    headers: { 'Authorization': `Bearer ${RENDER_API_KEY}` }
  });
  const envVars = await resEnv.json();
  console.log('Env vars:', envVars.map(e => ({ key: e.envVar?.key, value: e.envVar?.key?.includes('KEY') || e.envVar?.key?.includes('SECRET') || e.envVar?.key?.includes('CLAVE') || e.envVar?.key?.includes('TOKEN') ? '***REDACTED***' : e.envVar?.value })));
}

main().catch(console.error);
