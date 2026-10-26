/** Future reset timestamps for callers that only need an upcoming reset. */
export function usageResetAt(message: string, now = Date.now()): number | undefined {
  const at = usageResetHint(message, now);
  return at !== undefined && at > now ? at : undefined;
}

/** Retain elapsed reset hints too: providers can keep reporting a rounded reset minute. */
export function usageResetHint(message: string, now = Date.now()): number | undefined {
  const future = (t: number) => Number.isFinite(t) && t > now - 300000 ? t : undefined;
  const iso = /(?:reset\w*|try again)[^\n]{0,40}?(\d{4}-\d\d-\d\d[T ]\d\d:\d\d(?::\d\d(?:\.\d+)?)?(?:Z|[+-]\d\d:\d\d))/i.exec(message);
  if (iso) return future(Date.parse(iso[1]));
  const epoch = /(?:reset(?:s|_at|At)?[\s:="']+|\|)(\d{10}(?:\d{3})?)(?!\d)/i.exec(message);
  if (epoch) return future(Number(epoch[1]) * (epoch[1].length === 10 ? 1000 : 1));
  const relative = /(?:try again|reset\w*|retry)[^\n]{0,15}?\bin\s+(\d+(?:\.\d+)?)\s*(seconds?|secs?|minutes?|mins?|hours?|hrs?)/i.exec(message);
  if (relative) return now + Math.max(1000, Number(relative[1]) * (/^h/i.test(relative[2]) ? 3600000 : /^m/i.test(relative[2]) ? 60000 : 1000));
  const wall = /(?:resets?(?:\s+(?:at|on))?|try again at)\s+(?:(Jan(?:uary)?|Feb(?:ruary)?|Mar(?:ch)?|Apr(?:il)?|May|Jun(?:e)?|Jul(?:y)?|Aug(?:ust)?|Sep(?:tember)?|Oct(?:ober)?|Nov(?:ember)?|Dec(?:ember)?)\s+(\d{1,2})(?:,?\s+(\d{4}))?,?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(message);
  if (!wall) return;
  let hour = Number(wall[4]); const minute = Number(wall[5] ?? 0);
  if (minute > 59 || hour > (wall[6] ? 12 : 23) || (wall[6] && hour < 1)) return;
  if (wall[6]) hour = hour % 12 + (wall[6].toLowerCase() === 'pm' ? 12 : 0);
  const zone = wall[7] ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {timeZone:zone,year:'numeric',month:'numeric',day:'numeric',hour:'numeric',minute:'numeric',hourCycle:'h23'});
    const parts = (t:number) => Object.fromEntries(fmt.formatToParts(t).filter(p=>p.type!=='literal').map(p=>[p.type,Number(p.value)]));
    const current = parts(now);
    const monthNames = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
    const month = wall[1] ? monthNames.indexOf(wall[1].slice(0,3).toLowerCase()) + 1 : current.month;
    const day = wall[2] ? Number(wall[2]) : current.day;
    const year = wall[3] ? Number(wall[3]) : current.year;
    const candidates = (y:number,m:number,d:number) => {
      const wanted = Date.UTC(y,m-1,d,hour,minute);
      let guess = wanted;
      for(let i=0;i<4;i++) { const p=parts(guess); guess += wanted-Date.UTC(p.year,p.month-1,p.day,p.hour,p.minute); }
      return [-7200000,-3600000,0,3600000,7200000].map(delta=>guess+delta).filter(t=>{
        const p=parts(t); return p.year===y&&p.month===m&&p.day===d&&p.hour===hour&&p.minute===minute;
      }).sort((a,b)=>a-b);
    };
    const today = candidates(year,month,day);
    const next = today.find(t=>t>=now);
    if(next!==undefined) return next;
    // A same-day past clock time is stale, not a promise to wait until tomorrow.
    const recent = today.filter(t=>t>now-(wall[1] ? 300000 : 12*3600000)).at(-1);
    if(recent!==undefined) return recent;
    if(wall[1]) return wall[3] ? undefined : candidates(year+1,month,day).find(t=>t>now);
    const tomorrow=new Date(Date.UTC(year,month-1,day+1));
    return candidates(tomorrow.getUTCFullYear(),tomorrow.getUTCMonth()+1,tomorrow.getUTCDate()).find(t=>t>now);
  } catch { return undefined; }
}
