// Linux user-service supervision. Each LINA_HOME gets its own service profile.
import {execFile} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync} from 'node:fs';
import {homedir,userInfo} from 'node:os';
import {dirname,join,resolve} from 'node:path';
import {promisify} from 'node:util';
import {paths} from '../server/paths.js';
const exec=promisify(execFile);
const MARKER='# Managed by LINA';
export function serviceName(home=paths.home):string {
  return resolve(home)===join(homedir(),'.lina')?'lina.service':`lina-${createHash('sha256').update(resolve(home)).digest('hex').slice(0,12)}.service`;
}
export function serviceFile(home=paths.home):string {return join(process.env.XDG_CONFIG_HOME||join(homedir(),'.config'),'systemd','user',serviceName(home));}
export function managedService(home=paths.home):boolean {
  const file=serviceFile(home);return process.platform==='linux'&&existsSync(file)&&readFileSync(file,'utf8').startsWith(MARKER);
}
export async function serviceEnabled(home=paths.home):Promise<boolean> {
  if(!managedService(home))return false;
  try {const r=await exec('systemctl',['--user','is-enabled',serviceName(home)],{timeout:5000});return r.stdout.trim()==='enabled';}catch{return false;}
}
export async function serviceAction(action:'start'|'stop'|'restart',home=paths.home):Promise<void> {
  await exec('systemctl',['--user',action,serviceName(home)],{timeout:40000});
}
function quote(value:string,argumentsMode=false):string {
  if(/[\r\n\0]/.test(value))throw new Error('Service paths and environment must not contain control characters');
  const escaped=value.replace(/\\/g,'\\\\').replace(/"/g,'\\"').replace(/%/g,'%%');
  return '"'+(argumentsMode?escaped.replace(/\$/g,()=> '$$'):escaped)+'"';
}
export function renderService(opts:{node:string;script:string;execArgv:string[];home:string;path:string;port?:string}):string {
  if(opts.port!==undefined && (!/^\d+$/.test(opts.port)||Number(opts.port)<1||Number(opts.port)>65535))throw new Error('Invalid LINA_PORT for service');
  return `${MARKER}
[Unit]
Description=LINA autonomous goal daemon
StartLimitIntervalSec=0
[Service]
Type=simple
WorkingDirectory=${opts.home.replace(/%/g,'%%')}
ExecStart=${[opts.node,...opts.execArgv,opts.script,'daemon','run'].map(v=>quote(v,true)).join(' ')}
Environment=${quote('LINA_HOME='+opts.home)}
Environment=${quote('PATH='+opts.path)}
${opts.port ? 'Environment=LINA_PORT='+opts.port+'\n' : ''}Environment=LINA_DAEMON=1
Restart=always
RestartSec=5
TimeoutStopSec=30
KillMode=control-group
StandardOutput=append:${opts.home.replace(/%/g,'%%')}/daemon.log
StandardError=append:${opts.home.replace(/%/g,'%%')}/daemon.log
[Install]
WantedBy=default.target
`;
}
export async function enableService(entry:{script:string;execArgv:string[]}):Promise<void> {
  if(process.platform!=='linux')throw new Error('Automatic boot service currently requires Linux with a systemd user manager');
  await exec('systemctl',['--user','show-environment'],{timeout:5000});
  const file=serviceFile();
  if(existsSync(file)&&!managedService())throw new Error(`An unmanaged service already exists at ${file}; it was preserved`);
  mkdirSync(paths.home,{recursive:true,mode:0o700});mkdirSync(dirname(file),{recursive:true});
  writeFileSync(file,renderService({node:process.execPath,...entry,home:paths.home,path:process.env.PATH||'/usr/local/bin:/usr/bin:/bin',port:process.env.LINA_PORT}),{mode:0o600});
  await exec('systemctl',['--user','daemon-reload'],{timeout:10000});
  // Linger keeps the user manager alive after SSH logout and starts it at boot.
  await exec('loginctl',['enable-linger',userInfo().username],{timeout:10000});
  await exec('systemctl',['--user','enable',serviceName()],{timeout:10000});
}
export async function disableService():Promise<void> {
  if(!managedService())throw new Error('No LINA-managed service is installed for this profile');
  await exec('systemctl',['--user','disable','--now',serviceName()],{timeout:40000});
}
