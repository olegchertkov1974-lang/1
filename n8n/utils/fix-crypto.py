#!/usr/bin/env python3
"""Replace require('crypto') with pure JS HMAC-SHA256 in all workflow JSON files."""
import json
import re
import sys
import os

PURE_JS_HMAC = r"""// Pure JS SHA-256 + HMAC (n8n Cloud compatible)
function sha256(b){const K=[0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];let h0=0x6a09e667,h1=0xbb67ae85,h2=0x3c6ef372,h3=0xa54ff53a,h4=0x510e527f,h5=0x9b05688c,h6=0x1f83d9ab,h7=0x5be0cd19;const m=b.slice();const bl=m.length*8;m.push(0x80);while((m.length+8)%64!==0)m.push(0);m.push(0,0,0,0,(bl>>>24)&0xff,(bl>>>16)&0xff,(bl>>>8)&0xff,bl&0xff);function rr(v,n){return((v>>>n)|(v<<(32-n)))>>>0;}for(let i=0;i<m.length;i+=64){const w=new Array(64);for(let j=0;j<16;j++)w[j]=((m[i+j*4]<<24)|(m[i+j*4+1]<<16)|(m[i+j*4+2]<<8)|m[i+j*4+3])>>>0;for(let j=16;j<64;j++){const s0=rr(w[j-15],7)^rr(w[j-15],18)^(w[j-15]>>>3);const s1=rr(w[j-2],17)^rr(w[j-2],19)^(w[j-2]>>>10);w[j]=(w[j-16]+s0+w[j-7]+s1)>>>0;}let a=h0,bb=h1,c=h2,d=h3,e=h4,f=h5,g=h6,hh=h7;for(let j=0;j<64;j++){const S1=rr(e,6)^rr(e,11)^rr(e,25);const ch=(e&f)^((~e>>>0)&g);const t1=(hh+S1+ch+K[j]+w[j])>>>0;const S0=rr(a,2)^rr(a,13)^rr(a,22);const maj=(a&bb)^(a&c)^(bb&c);const t2=(S0+maj)>>>0;hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=bb;bb=a;a=(t1+t2)>>>0;}h0=(h0+a)>>>0;h1=(h1+bb)>>>0;h2=(h2+c)>>>0;h3=(h3+d)>>>0;h4=(h4+e)>>>0;h5=(h5+f)>>>0;h6=(h6+g)>>>0;h7=(h7+hh)>>>0;}const r=[];[h0,h1,h2,h3,h4,h5,h6,h7].forEach(v=>{r.push((v>>>24)&0xff,(v>>>16)&0xff,(v>>>8)&0xff,v&0xff);});return r;}
function hmacSHA256(ks,ms){const toB=s=>Array.from(s).map(c=>c.charCodeAt(0));let k=toB(ks);if(k.length>64)k=sha256(k);while(k.length<64)k.push(0);return sha256([...k.map(b=>b^0x5c),...sha256([...k.map(b=>b^0x36),...toB(ms)])]).map(b=>b.toString(16).padStart(2,'0')).join('');}"""

def fix_js_code(code):
    """Fix a single jsCode string."""
    changed = False

    # Remove require('crypto') lines
    if "require('crypto')" in code:
        code = re.sub(r"const crypto = require\('crypto'\);\n?", "", code)
        changed = True

    # Replace crypto.createHmac calls with hmacSHA256
    if "crypto.createHmac" in code:
        code = re.sub(
            r"crypto\.createHmac\('sha256',\s*(\w+)\)\.update\((\w+)\)\.digest\('hex'\)",
            r"hmacSHA256(\1, \2)",
            code
        )
        changed = True

    # Add HMAC functions if we made changes and they're not already there
    if changed and "hmacSHA256" in code and "function sha256" not in code:
        # Find a good insertion point - after the first variable declarations
        # Insert at the beginning of the code
        code = PURE_JS_HMAC + "\n" + code

    return code, changed

def process_file(filepath):
    """Process a single workflow JSON file."""
    with open(filepath, 'r') as f:
        data = json.load(f)

    total_changes = 0

    for node in data.get('nodes', []):
        params = node.get('parameters', {})
        if 'jsCode' in params:
            new_code, changed = fix_js_code(params['jsCode'])
            if changed:
                params['jsCode'] = new_code
                total_changes += 1
                print(f"  Fixed node: {node.get('name', 'unknown')}")

    if total_changes > 0:
        with open(filepath, 'w') as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        print(f"  Total nodes fixed: {total_changes}")
    else:
        print(f"  No crypto usage found")

    return total_changes

# Process all workflow files
workflows_dir = '/home/user/1/n8n/workflows'
total = 0
for filename in sorted(os.listdir(workflows_dir)):
    if filename.endswith('.json'):
        filepath = os.path.join(workflows_dir, filename)
        print(f"\nProcessing {filename}:")
        total += process_file(filepath)

print(f"\n=== Done! Fixed {total} nodes total ===")
