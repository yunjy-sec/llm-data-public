"""터미널 로그 (stdlib only).

모든 로그는 여기를 거친다. 앞에 yyyymmdd hhmmss 를 붙이고 즉시 flush한다.
버퍼링되면 파일로 리다이렉트했을 때 한참 뒤에야 보인다.

    log("SSO", "로그인 %s -> %s" % (ip, uid))
    -> 20260814 213045 [SSO] 로그인 10.1.2.3 -> your.loginid
"""

import sys
import time


def stamp():
    return time.strftime("%Y%m%d %H%M%S")


def log(tag, msg):
    try:
        sys.stdout.write("%s [%s] %s\n" % (stamp(), tag, msg))
        sys.stdout.flush()
    except Exception:
        pass
