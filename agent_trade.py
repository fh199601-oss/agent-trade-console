#!/usr/bin/env python3
"""AI entry; no keys, default preview. Install/start with setup.py first."""
import argparse, json, subprocess, sys
from pathlib import Path
from uuid import uuid4
sys.path.insert(0,str(Path(__file__).resolve().parent))
from runtime_paths import LOCAL, hidden_process_options, runtime_environment, configure_stdio

ROOT=Path(__file__).resolve().parent

def main():
    p=argparse.ArgumentParser()
    p.add_argument('--url');p.add_argument('--ca','--to',dest='ca')
    p.add_argument('--side',choices=['mint','buy','sell'],default='mint')
    p.add_argument('--scope',choices=['free','paid','all'],default='free')
    p.add_argument('--shares',default='max');p.add_argument('--budget-bnb');p.add_argument('--budget-usdt')
    p.add_argument('--budget-quote');p.add_argument('--quote-token')
    p.add_argument('--no-auto-claim',action='store_true');p.add_argument('--claim-sell-percent')
    p.add_argument('--claim-sell-slippage-bps',type=int,default=5000)
    p.add_argument('--claim-sell-currency',choices=['AUTO','BNB','USDT','WBNB','QUOTE'],default='AUTO')
    p.add_argument('--account',type=int);p.add_argument('--accounts')
    p.add_argument('--amount');p.add_argument('--percent');p.add_argument('--currency',choices=['BNB','USDT','WBNB','QUOTE','AUTO'])
    p.add_argument('--slippage-bps',type=int,default=100);p.add_argument('--slippage-mode',choices=['fixed','auto'])
    p.add_argument('--referral',choices=['account1','none'],default='account1');p.add_argument('--route-id')
    p.add_argument('--id');p.add_argument('--authorization');p.add_argument('--acknowledge-review',action='store_true')
    mode=p.add_mutually_exclusive_group()
    for name in ['go','inspect','preflight','learn','orders','corla-jobs']:mode.add_argument('--'+name,action='store_true')
    mode.add_argument('--follow');mode.add_argument('--corla-stop');mode.add_argument('--corla-resume')
    a=p.parse_args()
    try:
        if a.url and a.ca:raise ValueError('网址或 CA 只选一个')
        if a.account is not None and a.accounts:raise ValueError('钱包编号参数只选一个')
        if a.go and (not a.id or not a.authorization):raise ValueError('执行需要稳定 --id 和当前用户 --authorization；默认只预览')
        asset=a.url or a.ca
        if not asset and not (a.follow or a.orders or a.corla_jobs or a.corla_stop or a.corla_resume):raise ValueError('请提供网址或 CA')
        cfg=json.loads((LOCAL/'install.json').read_text(encoding='utf-8'))
        command=[cfg['node'],str(ROOT/'trade-console/cli.mjs')];body=None
        if a.follow:command+=['follow',a.follow]
        elif a.orders:command+=['orders']
        elif a.corla_jobs:command+=['corla-jobs']
        elif a.corla_stop:command+=['corla-stop',a.corla_stop]
        elif a.corla_resume:command+=['corla-resume',a.corla_resume]
        elif a.inspect or a.preflight or a.learn:command+=['inspect' if a.inspect else 'preflight' if a.preflight else 'learn',asset]
        else:
            i={'asset':asset,'side':a.side,'slippageBps':a.slippage_bps}
            if a.currency:i['currency']=a.currency
            if a.slippage_mode:i['slippageMode']=a.slippage_mode
            if a.side=='mint':
                if a.scope!='free' and a.budget_bnb is None and a.budget_usdt is None and a.budget_quote is None:raise ValueError('付费/全部额度需要明确本次预算')
                i.update(scope=a.scope,quantity='max' if a.shares=='max' else int(a.shares),maxBnb=a.budget_bnb or '0',maxUsdt=a.budget_usdt or '0',referral=a.referral)
                if a.route_id:i['routeId']=a.route_id
                if a.budget_quote is not None:i.update(maxQuote=a.budget_quote,quoteToken=a.quote_token)
                if a.no_auto_claim:i['autoClaim']=False
                if a.claim_sell_percent is not None:i['claimSell']={'percent':a.claim_sell_percent,'slippageBps':a.claim_sell_slippage_bps,'currency':a.claim_sell_currency}
            elif a.side=='buy':
                if a.amount is None:raise ValueError('买入需要 --amount')
                i['amount']=a.amount
            else:
                if a.percent is None:raise ValueError('卖出需要 --percent，按当前持仓计算')
                i['percent']=a.percent
            body={'id':a.id or 'preview-'+str(uuid4()),'intent':i,'execute':a.go,'authorization':a.authorization,'acknowledgeReview':a.acknowledge_review}
            if a.account is not None:i['account']=a.account;command+=['run','--file','-']
            else:
                if a.accounts:body['accounts']=[int(n) for n in a.accounts.split(',')]
                command+=['batch','--file','-']
        result=subprocess.run(command,cwd=ROOT,env=runtime_environment(),input=json.dumps(body) if body else None,capture_output=True,text=True,encoding='utf-8',timeout=180,**hidden_process_options())
        if result.stdout:print(result.stdout.strip())
        else:print(json.dumps({'success':False,'error':'服务未就绪或调用失败，请运行 python3 setup.py status','id':a.id},ensure_ascii=False))
        return result.returncode
    except subprocess.TimeoutExpired:
        print(json.dumps({'success':False,'error':'超时，仅 follow 原 ID，不能新建 ID 重发','id':a.id},ensure_ascii=False));return 1
    except Exception as e:
        print(json.dumps({'success':False,'error':str(e)},ensure_ascii=False));return 1

if __name__=='__main__':
    configure_stdio()
    sys.exit(main())
