(async()=>{document.querySelector('#addCardButton')?.click(); await new Promise(r=>setTimeout(r,800)); return document.querySelector('#cardDialog')?.open ? 'card dialog open' : 'no';})()
