"""Small real SiliconFlow probe; never prints keys or raw error responses."""
import argparse
import json
import time
from pathlib import Path
from .config import Config
from .clients import Models, ServiceError


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--output',type=Path,default=Path(__file__).parent/'reports/api_check.json')
    args=parser.parse_args()
    models=Models(Config.load())
    stages=[]
    actions=[('embedding',lambda:{'vectors':len(models.embed(['双非计算机学生保研失败后考研成功的经验'])), 'dimensions':1024}),
             ('reranker',lambda:{'scores':models.rerank('双非计算机保研失败后考研',
                 ['我在双非学习计算机，保研失败后重新准备考研并考上研究生。','今天的天气晴朗，适合出去散步。'])})]
    for name,action in actions:
        start=time.perf_counter()
        try:
            detail=action()
            stages.append({'stage':name,'status':'passed','detail':detail,'ms':round((time.perf_counter()-start)*1000)})
        except ServiceError as error:
            stages.append({'stage':name,'status':'failed','reason':str(error),'ms':round((time.perf_counter()-start)*1000)})
    report={'status':'passed' if all(s['status']=='passed' for s in stages) else 'failed',
            'stages':stages,'api_calls':models.calls,'database_tested':False}
    args.output.parent.mkdir(exist_ok=True,parents=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(report,ensure_ascii=False,indent=2))
    raise SystemExit(0 if report['status']=='passed' else 2)


if __name__=='__main__':
    main()
