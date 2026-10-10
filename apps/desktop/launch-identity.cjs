'use strict';
// Passive Main authority, not renderer data. Secret never crosses preload/CDP.
const {createHmac,timingSafeEqual}=require('node:crypto');
const fields=['version','launchNonce','mainPid','webContentsId','url','challenge','packaged'];
function signature(value,secret){return createHmac('sha256',secret).update(JSON.stringify(fields.map(k=>value[k]))).digest('hex');}
function createLaunchIdentity({launchNonce,mainPid,webContentsId,url,challenge,packaged},secret){
 if(typeof challenge!=='string'||!/^[a-f0-9]{64}$/.test(challenge))throw Error('INVALID_LAUNCH_CHALLENGE');
 const identity={version:1,launchNonce,mainPid,webContentsId,url,challenge,packaged};return {...identity,signature:signature(identity,secret)};
}
function verifyLaunchIdentity(value,expected,secret){
 if(!value||typeof value!=='object'||Object.keys(value).sort().join(',')!==[...fields,'signature'].sort().join(','))return false;
 if(value.version!==1||value.packaged!==true||!Number.isSafeInteger(value.webContentsId)||value.webContentsId<1||
 value.launchNonce!==expected.launchNonce||value.mainPid!==expected.mainPid||value.challenge!==expected.challenge||value.url!==expected.url||
 typeof value.signature!=='string'||!/^[a-f0-9]{64}$/.test(value.signature))return false;
 return timingSafeEqual(Buffer.from(value.signature,'hex'),Buffer.from(signature(value,secret),'hex'));
}
module.exports={createLaunchIdentity,verifyLaunchIdentity};
