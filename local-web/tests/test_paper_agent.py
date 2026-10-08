import sys,unittest,threading,time
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1] / "pulse-backend"))
from pulse_core.paper_agent import paper_source,chunks,PaperSummaryJobs,ClientError

class Summaries(unittest.TestCase):
 def test_abstract_used_instead_of_export_record(self):
  text,source,_=paper_source({'name':'papers.bib','text':'@article{x,title={Title}}','abstract':'Reported findings.'})
  self.assertEqual((text,source),('Reported findings.','Abstract'))
 def test_metadata_does_not_claim_findings(self):
  text,source,_=paper_source({'name':'Pasted paper','text':'Smith (2020). A research title.','title':'A research title'})
  self.assertEqual((text,source),('','Metadata only'))
 def test_all_text_is_partitioned_without_loss(self):
  text=('Methods and results.\n'*2000)+'Last section.'
  parts=list(chunks(text));self.assertEqual(''.join(parts),text);self.assertTrue(all(len(p)<=6000 for p in parts))
 def test_full_text_and_abstract_both_read(self):
  text,source,_=paper_source({'name':'study.pdf','text':'Detailed study text. '*40,'abstract':'Study abstract.'})
  self.assertIn('Study abstract.',text);self.assertIn('Detailed study',text);self.assertEqual(source,'Extracted paper text')
 def test_multi_paper_reports_are_rejected_before_model_access(self):
  with patch("pulse_core.paper_agent.agent_status") as status:
   with self.assertRaisesRegex(ClientError,"exactly one paper"):
    PaperSummaryJobs().start({"papers":[{"id":"one"},{"id":"two"}]})
   status.assert_not_called()
 def test_cloud_and_missing_models_rejected(self):
  with patch('pulse_core.paper_agent.agent_status',return_value={'online':True,'models':['local'],'model':'local'}):
   with self.assertRaises(ClientError):PaperSummaryJobs().start({'papers':[{}],'model':'cloud'})
 def test_offline_reports_connection_instruction(self):
  with patch('pulse_core.paper_agent.agent_status',return_value={'online':False,'message':'Open Ollama'}):
   with self.assertRaisesRegex(ClientError,'Open Ollama'):PaperSummaryJobs().start({'papers':[{}]})
 def test_long_paper_uses_every_section(self):
  prompts=[]
  def chat(model,prompt,cancel,max_tokens):prompts.append(prompt);return 'Factual notes.'
  jobs=PaperSummaryJobs();job={'view':{'model':'local','total':1},'cancel':threading.Event()}
  with patch('pulse_core.paper_agent.local_chat',side_effect=chat):
   result=jobs.summarize(job,{'text':('Beginning. '*1000)+'Final conclusion marker','title':'Study'},'',1)
  self.assertTrue(any('Final conclusion marker' in p for p in prompts));self.assertEqual(result['charactersRead'],11023)
 def test_cancellation_keeps_prior_results(self):
  jobs=PaperSummaryJobs();job={'view':{'model':'local','total':2,'results':[{'summary':'Saved'}]},'cancel':threading.Event()};job['cancel'].set()
  jobs._run(job,[{},{}],'');self.assertEqual(job['view']['status'],'cancelled');self.assertEqual(len(job['view']['results']),1)
 def test_one_failed_paper_does_not_lose_other_summaries(self):
  jobs=PaperSummaryJobs();job={'view':{'model':'local','total':2,'results':[]},'cancel':threading.Event()}
  with patch.object(jobs,'summarize',side_effect=[ClientError(502,'Interrupted'),{'summary':'Good','id':'2'}]):jobs._run(job,[{'title':'One'},{'title':'Two'}],'')
  self.assertEqual(job['view']['status'],'complete');self.assertEqual(len(job['view']['results']),2);self.assertEqual(job['view']['results'][1]['summary'],'Good')
if __name__=='__main__':unittest.main()
