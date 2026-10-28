"""AERO custom Apify Actor: live public product specifications, no fabricated fields."""
import json, math, os, re, urllib.request, urllib.parse
from html.parser import HTMLParser
ALLOWED = ('amazon.com','nike.com','zara.com','walmart.com','target.com','bestbuy.com','rei.com')
def validate(url):
    p=urllib.parse.urlsplit(url)
    if p.scheme!='https' or p.username or p.password or p.port or not any(p.hostname==h or (p.hostname or '').endswith('.'+h) for h in ALLOWED):
        raise ValueError('Only approved public retailer HTTPS pages are supported.')
    return url
class SafeRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        validate(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)
class ProductParser(HTMLParser):
    def __init__(self):
        super().__init__(); self.jsonld=[]; self.active=False; self.buffer=''; self.title=''; self.in_title=False
    def handle_starttag(self,tag,attrs):
        a=dict(attrs)
        if tag=='script' and a.get('type')=='application/ld+json': self.active=True; self.buffer=''
        if tag=='title': self.in_title=True
    def handle_endtag(self,tag):
        if tag=='script' and self.active:
            try: self.jsonld.append(json.loads(self.buffer))
            except ValueError: pass
            self.active=False
        if tag=='title': self.in_title=False
    def handle_data(self,data):
        if self.active: self.buffer+=data
        if self.in_title: self.title+=data

def products(value):
    if isinstance(value,list):
        for item in value: yield from products(item)
    elif isinstance(value,dict):
        types=value.get('@type') or []; types=[types] if isinstance(types,str) else types if isinstance(types,list) else []
        if 'Product' in types: yield value
        for key in ('@graph','mainEntity','itemListElement','item'):
            if key in value: yield from products(value[key])
def measurement(value,kind):
    if isinstance(value,dict):
        unit=str(value.get('unitCode') or value.get('unitText') or '').lower(); amount=value.get('value')
    elif isinstance(value,str):
        m=re.fullmatch(r'\s*([\d.]+)\s*([a-zA-Z]+)\s*',value)
        if not m:return None
        amount,unit=m.groups();unit=unit.lower()
    else:return None
    if isinstance(amount,bool):return None
    try: amount=float(amount)
    except (TypeError,ValueError):return None
    factors={'kg':1,'kgm':1,'kilograms':1,'g':.001,'grm':.001,'grams':.001,'lb':.45359237,'lbs':.45359237,'lbr':.45359237,'oz':.0283495} if kind=='weight' else {'cm':1,'cmt':1,'centimeters':1,'mm':.1,'mmt':.1,'in':2.54,'inch':2.54,'inches':2.54,'inh':2.54,'m':100,'mtr':100}
    if unit not in factors or not math.isfinite(amount):return None
    result=round(amount*factors[unit],4)
    # Round first: a value too small to show at 4 decimals is not a published measurement.
    # Check after scaling: a finite input can still overflow to inf once multiplied by the unit factor.
    return result if math.isfinite(result) and result>0 else None

def extract(url,html):
    p=ProductParser();p.feed(html);found=next((x for block in p.jsonld for x in products(block)),{})
    weight=measurement(found.get('weight'),'weight'); dims=[measurement(found.get(k),'length') for k in ('depth','width','height')]
    notes=[]
    if weight is None:notes.append('No explicit product weight with supported units was published. Enter packaged weight manually.')
    if not all(dims):notes.append('A complete set of dimensions was not published. Enter packaged dimensions manually.')
    notes.append('Product measurements may exclude packaging. Confirm the actual packed parcel before booking.')
    return {'title':str(found.get('name') or p.title or 'Product page')[:500],'url':url,'weightKg':weight,'dimensionsCm':dims if all(dims) else None,'notes':notes}
def platform(path,method='GET',data=None):
    token=os.environ['APIFY_TOKEN'];req=urllib.request.Request('https://api.apify.com/v2/'+path,data=json.dumps(data,allow_nan=False).encode() if data is not None else None,method=method,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(req,timeout=30) as response:return json.load(response)
def main():
    store=os.environ['APIFY_DEFAULT_KEY_VALUE_STORE_ID'];dataset=os.environ['APIFY_DEFAULT_DATASET_ID'];data=platform('key-value-stores/'+store+'/records/INPUT')
    url=validate(data['url']);opener=urllib.request.build_opener(SafeRedirect())
    request=urllib.request.Request(url,headers={'User-Agent':'AERO-Product-Specs/1.0 (public product research)'})
    with opener.open(request,timeout=30) as response:
        if 'text/html' not in response.headers.get('Content-Type',''):raise ValueError('Expected a public HTML product page.')
        body=response.read(5_000_001)
        if len(body)>5_000_000:raise ValueError('Product page is too large.')
        result=extract(url,body.decode('utf-8',errors='replace'))
    platform('datasets/'+dataset+'/items',method='POST',data=[result])
if __name__=='__main__':main()
