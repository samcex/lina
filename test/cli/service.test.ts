import {expect,it} from 'vitest';
import {parseArgs} from '../../src/cli/args.js';
import {renderService,serviceName} from '../../src/cli/service.js';
const opts={node:'/usr/bin/node',script:'/opt/lina/dist/lina.js',execArgv:['--enable-source-maps'],home:'/tmp/lina-state',path:'/usr/bin:/bin'};
it('supervises the foreground daemon across clean exits and crashes and retains its state home',()=>{
 const unit=renderService(opts);
 expect(unit).toContain('Restart=always');expect(unit).toContain('WantedBy=default.target');
 expect(unit).toContain('ExecStart="/usr/bin/node" "--enable-source-maps" "/opt/lina/dist/lina.js" "daemon" "run"');
 expect(unit).toContain('Environment="LINA_HOME=/tmp/lina-state"');expect(unit).toContain('KillMode=control-group');expect(unit).toContain('WorkingDirectory=/tmp/lina-state');
});
it('isolates custom state profiles so QA cannot stop the production service',()=>{
 expect(serviceName('/tmp/profile-a')).not.toBe(serviceName('/tmp/profile-b'));
 expect(serviceName('/tmp/profile-a')).toBe(serviceName('/tmp/profile-a'));
});
it('quotes literal paths and systemd expansion characters',()=>{
 const unit=renderService({...opts,script:'/opt/Some App/$name%20/lina.js'});
 expect(unit).toContain('"/opt/Some App/$$name%%20/lina.js"');
 expect(()=>renderService({...opts,home:'/tmp/unsafe\nExecStart=bad'})).toThrow();
});
it('retains an explicitly selected port and refuses invalid service configuration',()=>{
 expect(renderService({...opts,port:'17077'})).toContain('Environment=LINA_PORT=17077');
 expect(()=>renderService({...opts,port:'0'})).toThrow();expect(()=>renderService({...opts,port:'7077\nOther=bad'})).toThrow();
});
it.each(['enable','disable'])('accepts the daemon %s command',command=>{
 expect(parseArgs(['daemon',command]).positionals).toEqual([command]);
});
