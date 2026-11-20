// Daily App Store ratings snapshot for stats.lilizlab.com (run by GitHub Actions).
// Apple's public lookup/RSS endpoints block Cloudflare Workers, so this runs on GitHub's servers
// and writes ratings.json here; the Worker reads it from raw.githubusercontent.com every hour.
import fs from "node:fs";
const here = new URL(".", import.meta.url);
const OUT = new URL("ratings.json", here);
const SEEDS = JSON.parse(fs.readFileSync(new URL("apps.json", here), "utf8"));
const CC = "us,gb,ca,au,nz,ie,de,fr,it,es,nl,be,at,ch,se,no,dk,fi,pt,pl,cz,hu,gr,ro,tr,ru,ua,il,sa,ae,qa,kw,bh,om,jo,lb,eg,ma,dz,tn,za,ng,ke,gh,in,pk,bd,lk,np,id,my,sg,th,vn,ph,tw,hk,mo,jp,kr,cn,kz,uz,az,mx,br,ar,cl,co,pe,ec,uy,py,bo,ve,cr,pa,gt,do,sv,hn,ni,jm,tt,bs,bb,bz,bm,ky,vg,tc,ai,ag,dm,gd,kn,lc,vc,ms,gy,sr,is,ee,lv,lt,sk,si,hr,bg,mt,cy,lu,md,by,am,ge,mk,me,rs,ba,al,xk,mn,kh,la,mm,bt,mv,bn,fj,pg,sb,to,vu,fm,pw,nr,mu,sc,mg,mz,zw,zm,bw,na,ao,cm,ci,sn,ml,ne,bf,bj,tg,gm,gw,lr,sl,cv,td,cg,cd,ga,rw,tz,ug,mw,sz,ly,iq,ye,af,tj,tm,kg".split(",");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const UA = { "user-agent": "liliz-stats-ratings/1.0 (+https://lilizlab.com)", accept: "application/json" };

async function getJSON(url) {
  for (let i = 0; i < 4; i++) {
    let res;
    try { res = await fetch(url, { headers: UA }); } catch (e) { await sleep(5000); continue; }
    if (res.ok) { try { return JSON.parse(await res.text()); } catch { return null; } }
    if (res.status === 403 || res.status === 429 || res.status >= 500) { await sleep(20000 * (i + 1)); continue; }
    return null; // 400/404: storefront or app not available
  }
  return null;
}

// 1) find the developer account(s) behind the seed apps, so new apps are picked up automatically
const artists = new Set();
for (const cc of ["us", "tw", "jp"]) {
  const j = await getJSON(`https://itunes.apple.com/lookup?country=${cc}&id=${SEEDS.join(",")}`);
  for (const it of j?.results || []) if (it.artistId) artists.add(String(it.artistId));
  await sleep(1500);
}
console.log("developer ids:", [...artists].join(",") || "(none, using app ids)");

// 2) every storefront: star average + rating count per app
const by = {};
let ok = 0;
for (const cc of CC) {
  const url = artists.size
    ? `https://itunes.apple.com/lookup?country=${cc}&id=${[...artists].join(",")}&entity=software&limit=200`
    : `https://itunes.apple.com/lookup?country=${cc}&id=${SEEDS.join(",")}`;
  const j = await getJSON(url);
  if (j) ok++;
  for (const it of j?.results || []) {
    if (it.wrapperType !== "software" && it.kind !== "software") continue;
    const id = String(it.trackId);
    const a = (by[id] ||= { n: it.trackName, cc: {} });
    a.n = a.n || it.trackName;
    const n = +it.userRatingCount || 0;
    if (n > 0) a.cc[cc] = [Math.round((+it.averageUserRating || 0) * 100) / 100, n];
  }
  await sleep(1200);
}
console.log(`storefronts answered: ${ok}/${CC.length}, apps seen: ${Object.keys(by).length}`);
if (ok < CC.length / 2) { console.error("Too many storefronts failed; keeping the previous snapshot."); process.exit(1); }

// 3) written reviews from every storefront where the app has ratings (public RSS, newest first;
//    up to 10 pages of 50 per storefront), kept per app up to MAX_REVIEWS
const MAX_REVIEWS = 150;
const rv = {};
for (const [id, a] of Object.entries(by)) {
  const stores = Object.entries(a.cc).sort((x, y) => y[1][1] - x[1][1]).map(x => x[0]);
  const list = [];
  const seen = new Set();
  for (const cc of stores) {
    for (let page = 1; page <= 10; page++) {
      const j = await getJSON(`https://itunes.apple.com/${cc}/rss/customerreviews/page=${page}/id=${id}/sortby=mostrecent/json`);
      let en = j?.feed?.entry;
      await sleep(1200);
      if (!en) break;
      if (!Array.isArray(en)) en = [en];
      let added = 0;
      for (const x of en) {
        if (!x["im:rating"]) continue;
        const rid = x.id?.label || `${cc}-${x.updated?.label}-${x.author?.name?.label}`;
        if (seen.has(rid)) continue;
        seen.add(rid);
        added++;
        list.push({ s: +x["im:rating"].label || 0, t: x.title?.label || "", b: String(x.content?.label || "").slice(0, 1500),
          u: x.author?.name?.label || "", d: String(x.updated?.label || "").slice(0, 10), c: cc.toUpperCase(), v: x["im:version"]?.label || "" });
      }
      if (en.length < 50 || !added) break; // last page
    }
  }
  if (list.length) rv[id] = list.sort((x, y) => (x.d < y.d ? 1 : x.d > y.d ? -1 : 0)).slice(0, MAX_REVIEWS);
}
const rated = Object.values(by).filter(a => Object.keys(a.cc).length).length;
console.log(`apps with ratings: ${rated}, apps with written reviews: ${Object.keys(rv).length}`);
fs.writeFileSync(OUT, JSON.stringify({ at: new Date().toISOString(), countries: CC.length, by, rv }) + "\n");
