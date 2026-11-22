const RENDER_API_KEY = process.env.RENDER_API_KEY || ''; // nunca escribir la clave en el código (el repo es público)
const SERVICE_ID = process.env.RENDER_SERVICE_ID || '';

async function renderRequest(path, method = 'GET', data = null) {
  const url = `https://api.render.com/v1/services/${SERVICE_ID}${path}`;
  const options = {
    method,
    headers: {
      'Authorization': `Bearer ${RENDER_API_KEY}`,
      'Accept': 'application/json',
      'Content-Type': 'application/json',
    },
  };
  if (data) {
    options.body = JSON.stringify(data);
  }
  const res = await fetch(url, options);
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json };
}

async function main() {
  console.log('🚀 Disparando despliegue en Render Cloud...');
  const deployRes = await renderRequest('/deploys', 'POST', { clearCache: 'do_not_clear' });
  console.log('Respuesta de deploy:', deployRes.status, deployRes.data?.id || deployRes.data);

  console.log('⏳ Esperando a que el deploy pase a estado "live"...');
  let attempts = 0;
  while (attempts < 30) {
    await new Promise(r => setTimeout(r, 6000));
    attempts++;

    const listRes = await renderRequest('/deploys?limit=1');
    const latest = listRes.data?.[0]?.deploy;
    if (latest) {
      console.log(`[Intento ${attempts}] Estado actual: ${latest.status} (Commit: ${latest.commit?.id?.substring(0, 7) || 'n/a'})`);
      if (latest.status === 'live') {
        console.log('🎉 ¡El despliegue está LIVE en Render!');
        return;
      }
      if (latest.status === 'build_failed' || latest.status === 'deactivated') {
        console.error('❌ Error en el despliegue:', latest.status);
        process.exit(1);
      }
    }
  }
}

main().catch(console.error);
