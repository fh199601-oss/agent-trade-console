"""Double-click entry; Windows starts with bundled pythonw, no terminal loop."""
import html,json,os,sys,webbrowser
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent))
# Reopen with the same original wallet environment as login startup. Never
# rediscover a different CLI just because Finder/Explorer has a smaller PATH.
import startup
startup_error=False
try:
    saved=startup.read(startup.support_directory()/'startup.json')
    if saved and Path(saved.get('root','')).resolve()==Path(__file__).resolve().parent:
        startup.restore_environment(saved)
except (OSError,ValueError,TypeError,KeyError,RuntimeError):
    startup_error=True
import setup
from runtime_paths import LOCAL
from wallet_bridge import account_lock,BridgeError

def main():
    LOCAL.mkdir(parents=True,exist_ok=True,mode=0o700)
    page=LOCAL/'startup.html'
    def show(message,url=None,waiting=False):
        if url and not url.startswith('http://127.0.0.1:'):raise ValueError('只允许本机看板')
        refresh='<meta http-equiv="refresh" content="2">' if waiting else ''
        link=f'<p><a href="{html.escape(url,quote=True)}">打开交易看板 →</a></p>' if url else ''
        body='<!doctype html><meta charset="utf-8">'+refresh+'<title>AGENT · 启动看板</title><style>body{background:#11170f;color:#e5eddf;font:18px system-ui;max-width:750px;margin:10vh auto;padding:30px}h1,a{color:#bbf768}p{line-height:1.7;white-space:pre-wrap}</style><h1>A› AGENT 交易台</h1><p>'+html.escape(message)+'</p>'+link+'<p>仅启动真实交易看板；没有本人交易操作时不会下单。</p>'
        page.write_text(body,encoding='utf-8')
    try:
        if startup_error:
            show('本机启动配置无效，未调用钱包。请让安装 AI 检查原安装的启动配置。')
            if '--no-browser' not in sys.argv:webbrowser.open(page.as_uri())
            return 1
        # A second click only reopens the existing installation, not another server.
        with account_lock({'command':[str(setup.ROOT/'setup.py')]},timeout=3):
            show('正在启动…',waiting=True)
            if '--no-browser' not in sys.argv:webbrowser.open(page.as_uri())
            sys.argv=[sys.argv[0],*[a for a in sys.argv[1:] if a!='--no-browser']]
            setup.progress=lambda message:show(message,waiting=True)
            result=setup.main()
            if result.get('success'):
                url=result.get('url');issues=result.get('issues',[])
                message='看板已启动 · 真实交易模式\n已绑定钱包：'+str(result.get('walletCount',0))
                if issues:message+='\n钱包仍需处理：\n'+'\n'.join(x.get('message') or x.get('code','未知问题') for x in issues)
                integration=result.get('startup') or {}
                if integration.get('enabled'):message+='\n已设置登录自动启动，可使用桌面 AGENT 快捷入口。'
                if integration.get('error') or integration.get('notice'):message+='\n登录自启：'+str(integration.get('error') or integration.get('notice'))
                show(message,url)
                if url and not issues and '--no-browser' not in sys.orig_argv:webbrowser.open(url)
            else:show('启动未完成：'+result.get('error','未知错误')+'\n请把此提示发给安装 AI；不要发送私钥或登录凭据。')
            setup.save(LOCAL/'last-launch.json',result)
            return 0 if result.get('success') else 1
    except BridgeError:
        show('已有一次安装/启动正在运行，请等待该页面的进度；不会重复启动钱包。')
        return 1
    except Exception:
        show('启动未完成，请让 AI 检查本机运行目录的读写权限。没有发出交易。')
        return 1

if __name__=='__main__':sys.exit(main())
