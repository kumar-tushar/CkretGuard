import { cp, mkdir, readFile, readdir, writeFile, rm, lstat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root=fileURLToPath(new URL('../',import.meta.url));
const artifacts=path.join(root,'artifacts');
const manifest=JSON.parse(await readFile(path.join(root,'plugin','plugin.json'),'utf8'));
const built=JSON.parse(await readFile(path.join(root,'dist','manifest.json'),'utf8'));
if(manifest.version!==built.version) throw new Error('Plugin and extension versions differ');
const output=path.join(artifacts,'secret-shield');
await mkdir(artifacts,{recursive:true});
await rm(output,{recursive:true,force:true});
await cp(path.join(root,'plugin'),output,{recursive:true});
const skill=path.join(output,'skills','setup-secret-shield');
await cp(path.join(root,'dist'),path.join(skill,'extension'),{recursive:true});
await mkdir(path.join(skill,'references'),{recursive:true});
await cp(path.join(root,'docs','ENTERPRISE.md'),path.join(skill,'references','ENTERPRISE.md'));
await mkdir(path.join(output,'assets'),{recursive:true});
await cp(path.join(root,'dist','icons','ckretguard-128.png'),path.join(output,'assets','ckretguard.png'));

async function files(directory,prefix='') {
  const result=[];
  for(const item of (await readdir(directory,{withFileTypes:true})).sort((a,b)=>a.name.localeCompare(b.name))) {
    const relative=path.posix.join(prefix,item.name),absolute=path.join(directory,item.name);
    const stat=await lstat(absolute);
    if(stat.isSymbolicLink()) throw new Error('Package contains a symlink');
    if(item.isDirectory()) result.push(...await files(absolute,relative));
    else result.push(relative);
  }
  return result;
}
const pluginFiles=await files(output);
if(manifest.$schema!=='https://agent-plugins.org/schemas/1.0.0/plugin.schema.json') throw new Error('Invalid plugin schema');
if(manifest.name!=='secret-shield'||!/^\d+\.\d+\.\d+$/.test(manifest.version)) throw new Error('Invalid identity');
const presentation=manifest.extensions['com.openai'].interface;
if(presentation.shortDescription.length>30) throw new Error('Plugin subtitle exceeds 30 characters');
for(const field of ['logo','composerIcon']) {
  if(!pluginFiles.includes(presentation[field].replace(/^\.\//,''))) throw new Error('Missing icon');
}
const source=await readFile(path.join(skill,'SKILL.md'),'utf8');
if(!/^---\nname: setup-secret-shield\ndescription: .+\n---\n/.test(source)) throw new Error('Invalid skill frontmatter');
for(const file of pluginFiles) {
  if(/(?:^|\/)(?:node_modules|\.git|\.env)(?:\/|$)/.test(file)) throw new Error('Unwanted package file');
  if(file.endsWith('.json')) JSON.parse(await readFile(path.join(output,file),'utf8'));
}
const extensionZip=path.join(artifacts,`secret-shield-chrome-${manifest.version}.zip`);
const pluginZip=path.join(artifacts,`secret-shield-plugin-${manifest.version}.zip`);
async function archive(source,destination,include) {
  await rm(destination,{force:true});
  execFileSync('zip',['-q','-r',destination,...include],{cwd:source});
  execFileSync('unzip',['-tq',destination],{stdio:'pipe'});
  const entries=execFileSync('unzip',['-Z1',destination],{encoding:'utf8'}).trim().split('\n');
  if(entries.some(name=>name.startsWith('/')||name.split('/').includes('..'))) throw new Error('Unsafe archive path');
  return {name:path.basename(destination),sha256:createHash('sha256').update(await readFile(destination)).digest('hex'),files:entries.filter(name=>!name.endsWith('/')).length};
}
const archives=[];
archives.push(await archive(path.join(root,'dist'),extensionZip,await readdir(path.join(root,'dist'))));
archives.push(await archive(artifacts,pluginZip,['secret-shield']));
const hashes={};
for(const name of await files(path.join(root,'dist'))) hashes[name]=createHash('sha256').update(await readFile(path.join(root,'dist',name))).digest('hex');
await writeFile(path.join(artifacts,'release.json'),JSON.stringify({version:manifest.version,archives,extensionFiles:hashes},null,2)+'\n');
console.log(JSON.stringify({version:manifest.version,archives},null,2));
