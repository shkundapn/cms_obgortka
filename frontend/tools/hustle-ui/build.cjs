let esbuild;try {esbuild=require('esbuild');} catch {esbuild=require('../../output/frontend-vendor/node_modules/esbuild');}
const path=require('node:path');
const root=path.resolve(__dirname,'../..');process.chdir(root);
const nodePaths=[path.join(__dirname,'node_modules'),path.resolve('output/frontend-vendor/node_modules')];
const fs=require('node:fs');
const outVendor=fs.existsSync(path.join(root,'hustle/vendor'))?path.join(root,'hustle/vendor'):path.join(root,'app/static/hustle/vendor');
const target=process.argv[2]||'all';
(async()=>{
 if(target==='all'||target==='ui'){
  await esbuild.build({entryPoints:[path.join(root,'tools/hustle-ui/rich-text.js')],nodePaths,bundle:true,minify:true,format:'iife',outfile:path.join(outVendor,'rich-text.js'),external:['./diagrams.js'],legalComments:'linked'});
  await esbuild.build({entryPoints:[path.join(root,'tools/hustle-ui/diagrams.js')],nodePaths,bundle:true,minify:true,format:'esm',splitting:true,outdir:outVendor,legalComments:'linked'});
 }
 if(target==='all'||target==='srs'){
  await esbuild.build({entryPoints:[path.join(root,'src/services/srsEngine.ts')],nodePaths,bundle:true,minify:true,format:'iife',globalName:'HustleSRSEngineBundle',outfile:path.join(outVendor,'srs-engine.js'),legalComments:'linked'});
 }
})();
