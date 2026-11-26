#!/bin/sh
# Give every deploy fresh file URLs so phones never keep an old copy: styles.css?v=<stamp>, app.js?v=<stamp>…
v=$(date +%y%m%d%H%M)
sed -i -E "s#(href=\"styles\.css|src=\"(config|i18n|core|store|places|app)\.js)(\?v=[0-9]+)?\"#\1?v=$v\"#g" index.html
sed -i -E "s#const CACHE = 'tarweeqa-[^']*'#const CACHE = 'tarweeqa-$v'#" sw.js
echo "stamped $v"
