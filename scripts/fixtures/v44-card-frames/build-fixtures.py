from pathlib import Path
from PIL import Image,ImageDraw
import json,hashlib
O=Path(__file__).resolve().parent;I=O/'images';I.mkdir(exist_ok=True)
def make(name,rects=(),size=(320,480)):
 im=Image.new('RGB',size,(40,44,49));d=ImageDraw.Draw(im)
 for box,color in rects:
  d.rectangle(box,fill=color,outline=(230,230,235),width=3)
  x,y,X,Y=box;d.rectangle((x+15,y+20,X-15,int((y+Y)/2)),fill=(75,105,135));d.line((x+15,Y-22,X-15,Y-22),fill=(120,120,120),width=2)
  # No letters/numbers at all: detector must consume card pixels, not perfect OCR text.
 im.save(I/(name+'.png'));return {'path':'images/'+name+'.png','size':list(size),'sha256':hashlib.sha256((I/(name+'.png')).read_bytes()).hexdigest(),'containsReadableCardNumber':False}
assets={}
assets['blank']=make('blank');assets['cardA']=make('cardA',[((70,95,250,345),(170,70,110))]);assets['cardB']=make('cardB',[((70,95,250,345),(70,170,110))]);assets['jitter']=make('jitter',[((72,96,252,346),(170,70,110))]);assets['moveLeft']=make('moveLeft',[((25,95,205,345),(170,70,110))]);assets['moveRight']=make('moveRight',[((110,95,290,345),(170,70,110))]);assets['outside']=make('outside',[((1,95,181,345),(170,70,110))]);assets['twoCards']=make('twoCards',[((30,110,145,270),(170,70,110)),((175,110,290,270),(70,170,110))]);assets['wrongAspect']=make('wrongAspect',[((70,140,250,260),(170,70,110))]);assets['small']=make('small',[((130,190,190,273),(170,70,110))]);assets['landscapePreview']=make('landscapePreview',[((150,65,330,315),(170,70,110))],(480,360));assets['tallPreview']=make('tallPreview',[((70,140,250,390),(170,70,110))],(320,640))
def frames(key,n,**extra):return [{'image':key,'dtMs':700,**extra}for _ in range(n)]
def events(*seq):return [x for s in seq for x in (s if isinstance(s,list)else[s])]
def case(name,sequence,captures=0,requests=0,charges=0,**extra):return {'name':name,'events':sequence,'expected':{'captures':captures,'mockRecognitionRequests':requests,'quotaCommits':charges,**extra}}
a=frames('cardA',4);blank=frames('blank',45);ad={'action':'tapAddResult'};cancel={'action':'cancel'}
cases=[
 case('empty45_then_card_resumes_without_OCR_or_shutter',events(blank,a),1,1),
 case('empty90_never_blind_capture',frames('blank',90)),
 case('stable_card_without_any_readable_card_number',a,1,1),
 case('small_hand_jitter_is_stable',events(frames('cardA',1),frames('jitter',3)),1,1),
 case('moving_card_never_captures',events(*[frames(k,1)for k in ['moveLeft','moveRight']*5])),
 case('motion_then_settles',events(frames('moveLeft',1),frames('moveRight',1),a),1,1),
 case('outside_scan_frame',frames('outside',5)),
 case('two_cards_ambiguous',frames('twoCards',5)),
 case('wrong_aspect_not_a_card',frames('wrongAspect',5)),
 case('tiny_card_unusable',frames('small',5)),
 case('landscape_preview_mapping',frames('landscapePreview',4),1,1),
 case('tall_preview_mapping',frames('tallPreview',4),1,1),
 case('background_drops_frames_then_requires_new_stability',events(frames('cardA',1),{'action':'background'},frames('cardA',6),{'action':'foreground'},a),1,1,lateFrameMustBeIgnored=True),
 case('consent_absent_no_capture',frames('cardA',6,consent=False)),
 case('quota_unavailable_no_capture',frames('cardA',6,allowance=0)),
 case('blur_or_screen_exit_no_capture',events({'action':'blur'},a)),
 case('pending_capture_cancel_late_result_no_commit',events(frames('cardA',4,captureMode='deferred'),cancel,{'action':'resolvePendingCaptureAndRecognition'}),1,0,0,lateCaptureMustBeIgnored=True),
 case('same_card_result_add_once_then_no_recapture',events(a,ad,ad,{'action':'closeResult'},frames('cardA',12)),1,1,1),
 case('remove_card_then_different_card_once_each',events(a,ad,{'action':'closeResult'},frames('blank',3),frames('cardB',4),ad),2,2,2),
 case('cover_number_only_does_not_rearm_same_card',events(a,ad,{'action':'closeResult'},frames('cardA',10,occludeTextOnly=True)),1,1,1),
 case('provider_mock_failure_no_auto_retry_or_charge',events(frames('cardA',4,mockResponse='503'),frames('cardA',10)),1,1,0),
]
spec={'schema':1,'state':'CONTRACT_FIXTURES_PREPARED_NOT_CANDIDATE_PASS','input':'synthetic image frames; no OCR tokens supplied to detector','network':'must be replaced with local in-memory recognition seam; reject all real HTTP','clock':'virtual, no 45*700ms wall wait','initialState':{'consent':True,'allowance':50,'foreground':True,'focused':True,'scanFrame':{'x':30,'y':55,'width':260,'height':360}},'frameOverrides':{'landscapePreview':{'scanFrame':{'x':110,'y':30,'width':260,'height':300}},'tallPreview':{'scanFrame':{'x':30,'y':80,'width':260,'height':400}}},'assets':assets,'cases':cases,'rules':['Do not expose fixture asset name, expected bounds or identity to production detector; feed decoded pixels only','Assertions must count real analyzer→screen automatic capture→mock request→result→explicit Add events','No card-number OCR precondition','No pixel detector or candidate implementation is mocked at boundary under test','No frame polling photos or timer-only shutter','Same card held stays disarmed after result; OCR disappearance is not card removal','Physical camera/provider/real quota QA remain CANCELLED/UNTESTED']}
(O/'auto-frame-traces.json').write_text(json.dumps(spec,indent=2)+'\n')
print(json.dumps({'images':len(assets),'traces':len(cases),'noOCRText':True,'candidatePassClaim':False}))
