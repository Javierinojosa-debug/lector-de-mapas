// Edge function: proxy a la API de Claude con la clave propia del usuario, en streaming.
const RULES=`Eres un instructor experto en topografía militar española (cartas del Servicio Geográfico del Ejército, Serie L y MTN 1:50.000/1:25.000, cuadrícula UTM/MGRS, milésimas OTAN 6400). Ayudas a una alumna a resolver ejercicios sobre una carta real de la que te manda una foto.

Cómo responder:
- Responde siempre en español, claro y directo.
- Las marcas del usuario están en ROJO sobre la foto: puntos con letra (A, B…), líneas rectas ("línea 1"…) y trazos a mano alzada. Te paso también su posición aproximada en la imagen. Si hay una segunda imagen, es un recorte ampliado de la zona marcada.
- Primero di en una línea qué has leído del mapa que importa para la pregunta (números de cuadrícula alrededor, curvas maestras y sus cotas, escala, equidistancia, variación). Si algo no se lee, dilo y pide que lo compruebe.
- Después resuelve paso a paso con las cuentas (escala, interpolación, acimut desde norte de cuadrícula en sentido horario, corrección magnética, inverso ±180°/±3200 mil, pendiente = desnivel/distancia ×100…).
- Termina con el resultado destacado en negrita y, si aplica, el margen de error razonable.
- Coordenadas: formato MGRS "huso+banda cuadrado XXX YYY" (derecha y luego arriba).
- No inventes datos que no se ven. Si la foto está en perspectiva o torcida, tenlo en cuenta y avisa de la incertidumbre.
- Usa listas numeradas para los pasos. Sé breve: máximo unas 200 palabras salvo que pidan más.

Reglas de posición:
- Todas las imágenes llevan reglas negras en los márgenes blancos con el porcentaje de la FOTO COMPLETA: x de 0 (izquierda) a 100 (derecha) e y de 0 (arriba) a 100 (abajo). Son las mismas coordenadas en todas las imágenes, también en las ampliaciones. Las posiciones de las marcas del usuario te las doy en ese sistema.

Dibujar en el mapa:
- Cuando la pregunta pida marcar, señalar, trazar o dibujar algo (punto más alto o más bajo, una línea, un itinerario, la línea de mínima o máxima pendiente, una divisoria, una vaguada, una zona…), o cuando un dibujo aclare mucho la respuesta, AÑADE AL FINAL un bloque exactamente así:
\`\`\`dibujo
{"elementos":[{"tipo":"punto","x":41.2,"y":63.5,"etiqueta":"Máx. 1.004 m"},{"tipo":"linea","puntos":[[41.2,63.5],[45.0,60.1],[52.3,58.8]],"etiqueta":"Mínima pendiente"},{"tipo":"zona","puntos":[[10,10],[20,10],[20,20]],"etiqueta":"Zona batida"}]}
\`\`\`
- x e y en el sistema de las reglas, con un decimal. Mide con las reglas de la imagen ampliada que mejor muestre la zona.
- Las líneas que siguen el terreno (mínima pendiente, máxima pendiente, caminos, cursos de agua) deben llevar muchos puntos intermedios (cada 1–2 %), siguiendo las curvas de nivel: la mínima pendiente va lo más paralela posible a las curvas y las cruza de forma oblicua y repartida; la máxima pendiente cruza cada curva en perpendicular, por donde están más juntas. Una línea "de X a Y" va del primer al último punto.
- Etiquetas cortas (máx. 25 caracteres). Máximo 8 elementos.
- El bloque no se muestra como texto: el programa lo dibuja en azul. No lo menciones ni lo expliques; en el texto di solo qué has dibujado y por qué.
- Si no puedes situarlo con confianza, no dibujes y explica qué falta.`;
const MODELS=['claude-sonnet-5-5','claude-opus-5-5'];
const bad=(msg,status=400)=>Response.json({error:msg},{status});

export default async (req)=>{
  if(req.method!=='POST')return bad('Método no permitido',405);
  // Solo la clave propia de la API de Claude (variable CLAUDE_API_KEY), siempre contra api.anthropic.com: el coste va a tu cuenta de Anthropic, nunca a créditos de Netlify.
  const key=Netlify.env.get('CLAUDE_API_KEY'),base='https://api.anthropic.com';
  if(!key)return bad('Falta la clave de la API de Claude: añade la variable CLAUDE_API_KEY en Netlify y vuelve a desplegar.',503);
  let body;try{body=await req.json()}catch{return bad('Petición no válida')}
  const turns=Array.isArray(body.turns)?body.turns.slice(-9):[];const images=Array.isArray(body.images)?body.images.slice(0,6):[];
  if(!turns.length||turns[turns.length-1].role!=='user')return bad('Falta la pregunta');
  if(images.some(b=>typeof b!=='string'||b.length>2_500_000))return bad('Imagen demasiado grande');
  const msgs=[];
  for(const t of turns){const role=t.role==='assistant'?'assistant':'user';const text=String(t.content||'').slice(0,20000);if(!text)continue;
    if(msgs.length&&msgs[msgs.length-1].role===role)msgs[msgs.length-1].content[0].text+='\n\n'+text;else msgs.push({role,content:[{type:'text',text}]})}
  while(msgs.length&&msgs[0].role!=='user')msgs.shift();
  const last=msgs[msgs.length-1];
  last.content=[...images.map(data=>({type:'image',source:{type:'base64',media_type:'image/jpeg',data}})),...last.content];
  const enc=new TextEncoder(),dec=new TextDecoder();
  let stopR='';
  const stream=new ReadableStream({async start(ctrl){
    const send=t=>{try{ctrl.enqueue(enc.encode(t))}catch{}};
    const T0=Date.now();console.log('ask start imgs',images.length);
    send(' '); // primer byte inmediato para que la conexión no caduque
    let got=false;const ping=setInterval(()=>{if(!got)send(' ')},5000);
    try{
      let r,lastErr='';
      const call=(model,extra)=>fetch(base+'/v1/messages',{method:'POST',headers:{'x-api-key':key,'anthropic-version':'2023-06-01','content-type':'application/json'},
          body:JSON.stringify({model,max_tokens:2000,system:RULES,messages:msgs,stream:true,...extra})});
      for(const model of MODELS){
        let mode='disabled';r=await call(model,{thinking:{type:'disabled'}});
        if(!r.ok&&r.status===400){lastErr=(await r.text()).slice(0,200);mode='budget';r=await call(model,{thinking:{type:'enabled',budget_tokens:1024},max_tokens:3000})}
        if(!r.ok&&r.status===400){lastErr=(await r.text()).slice(0,200);mode='default';r=await call(model,{})}
        if(r.ok)send('<<M:'+model+':'+mode+'>>');
        console.log('gateway',model,r.status,Date.now()-T0,'ms');if(r.ok)break;lastErr=(await r.text()).slice(0,200);if(r.status===429)break;
      }
      if(!r.ok){send('\n[ERROR] '+(r.status===429?'Demasiadas peticiones a la IA. Espera un poco.':'La IA no ha respondido ('+r.status+'). '+lastErr));return}
      const reader=r.body.getReader();let buf='',stop='';
      for(;;){const {done,value}=await reader.read();if(done)break;buf+=dec.decode(value,{stream:true});let i;
        while((i=buf.indexOf('\n\n'))>=0){const ev=buf.slice(0,i);buf=buf.slice(i+2);const line=ev.split('\n').find(l=>l.startsWith('data:'));if(!line)continue;
          try{const j=JSON.parse(line.slice(5));if(j.type==='content_block_start'){const bt=j.content_block&&j.content_block.type;console.log('block',bt,Date.now()-T0);if(bt&&bt!=='text')send('<<T:'+bt+'>>')}if(j.type==='content_block_delta'&&j.delta&&j.delta.type==='text_delta'){if(!got)console.log('first text',Date.now()-T0);got=true;send(j.delta.text)}
            else if(j.type==='message_delta'&&j.delta&&j.delta.stop_reason){stop=j.delta.stop_reason;stopR=stop}else if(j.type==='message_stop'&&stop!=='max_tokens')send(got?'\n<<FIN>>':'\n[ERROR] La IA no ha escrito respuesta ('+(stop||'sin motivo')+'). Vuelve a preguntar.');else if(j.type==='error')send('\n[ERROR] '+(j.error&&j.error.message||'error de la IA'))}catch{}}}
    }catch(e){console.log('error',String(e),Date.now()-T0);send('\n[ERROR] Conexión con la IA interrumpida.')}
    finally{console.log('end',stopR,Date.now()-T0);clearInterval(ping);try{ctrl.close()}catch{}}
  }});
  return new Response(stream,{headers:{'content-type':'text/plain; charset=utf-8','cache-control':'no-store','x-accel-buffering':'no'}});
};

export const config={path:'/api/ask',rateLimit:{windowLimit:20,windowSize:60,aggregateBy:['ip','domain']}};
