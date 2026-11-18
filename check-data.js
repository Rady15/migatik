const {PrismaClient}=require('@prisma/client');
const p=new PrismaClient();
p.hotspotActive.findMany({where:{routerId:'cmwkwemwi000uujmsdm6e60ne'}})
  .then(h=>{console.log('HotspotActive:',h.length); h.forEach(x=>console.log(x.macAddress,x.address,x.username)); return p.hotspotHost.findMany({where:{routerId:'cmwkwemwi000uujmsdm6e60ne'}})})
  .then(h=>{console.log('HotspotHost:',h.length); h.forEach(x=>console.log(x.macAddress,x.address)); return p.pppSession.findMany({where:{routerId:'cmwkwemwi000uujmsdm6e60ne'}})})
  .then(p=>{console.log('PPP:',p.length); p.forEach(x=>console.log(x.username,x.address,x.service)); return p.pppSecret.findMany({where:{routerId:'cmwkwemwi000uujmsdm6e60ne'}})})
  .then(s=>{console.log('PPP Secrets:',s.length); s.forEach(x=>console.log(x.name,x.profile,x.service)); return p.pppProfile.findMany({where:{routerId:'cmwkwemwi000uujmsdm6e60ne'}})})
  .then(p=>{console.log('PPP Profiles:',p.length); p.forEach(x=>console.log(x.name,x.localAddress)); return p.networkResource.findMany({where:{routerId:'cmwkwemwi000uujmsdm6e60ne',source:{in:['wireless','wifi','capsman','capsman_caps']}}})})
  .then(r=>{console.log('Wireless sources:',r.length); r.forEach(x=>console.log(x.source,x.key)); process.exit(0)})
  .catch(e=>{console.error(e); process.exit(1)});