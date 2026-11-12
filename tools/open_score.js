(async()=>{const b=document.querySelector('#goToScore'); if(b){b.click(); await new Promise(r=>setTimeout(r,900));} return document.querySelector('#reviewDialog')?.open ? 'score step' : 'no';})()
