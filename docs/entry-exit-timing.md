# 判断価格と cooldown

## 判断価格

戦略は、通常取引時間の snapshot を判断価格に使う。条件は、市場時刻と取得時刻がどちらも 5 分以内であること。未来時刻・不正値・出所不明・時間外の quote は使わない。条件を満たす snapshot が無ければ直近の 60 分足終値に fallback し、その場合は従来どおり BUY の鮮度チェックがかかる。SMA / ATR / トレンド判定は、どちらの場合も日足から計算する。

strategy cron の 15 分間隔は変わらない。tick 単位の執行ではない。

## cooldown

BUY cooldown は未保有のときだけ効く。保有中は cooldown 中でも、stop / take-profit / time-stop の exit が通常どおり発動する。
