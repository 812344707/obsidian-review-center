use fsrs::{FSRS, FSRSItem, FSRSReview, ComputeParametersInput, SimulatorConfig, RevlogEntry, RevlogReviewKind};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
#[derive(Deserialize)]
struct Review { rating: u32, delta_t: u32 }
#[derive(Deserialize)]
struct Sample { reviews: Vec<Review>, cid: i64 }
#[derive(Deserialize)]
struct Log { id: i64, cid: i64, rating: u8, interval: i32, last_interval: i32, duration: u32, kind: u8 }
#[derive(Deserialize)]
struct Input {
  action: String, samples: Vec<Sample>, weights: Vec<f32>, logs: Vec<Log>,
  health: bool, relearning_steps: usize, learning_steps: usize,
  new_limit: usize, review_limit: usize, maximum_interval: f32,
  new_ignore_review: bool, deck_size: usize, cutoff: i64,
}
fn emit(value: Value) { println!("{}", value); let _ = std::io::stdout().flush(); }
fn run(input: Input) -> Result<Value, String> {
  let usable: Vec<&Sample> = input.samples.iter().filter(|s| s.reviews.iter().any(|r| r.delta_t > 0)).collect();
  let dataset: Vec<FSRSItem> = usable.iter().map(|s| FSRSItem { reviews: s.reviews.iter().map(|r| FSRSReview { rating:r.rating, delta_t:r.delta_t }).collect() }).collect();
  let ids: Vec<i64> = usable.iter().map(|s| s.cid).collect();
  let eligible = dataset.iter().filter(|i| i.reviews.len() > 1 && i.reviews.last().is_some_and(|r| r.delta_t > 0)).count();
  if eligible < 64 { return Err(format!("至少需要 64 条跨日复习记录；当前有 {} 条。原参数保持不变。", eligible)); }
  let train = ComputeParametersInput { train_set:dataset.clone(), card_ids:Some(ids), progress:None, enable_short_term:true, num_relearning_steps:Some(input.relearning_steps), training_config:None };
  if input.action == "optimize" {
    emit(json!({"progress":0.15,"message":"正在拟合个人记忆参数"}));
    let weights = fsrs::compute_parameters(train.clone()).map_err(|e| e.to_string())?;
    emit(json!({"progress":0.7,"message":"正在评估参数"}));
    let model = FSRS::new(&weights).map_err(|e| e.to_string())?;
    let before = FSRS::new(&input.weights).map_err(|e| e.to_string())?.evaluate(dataset.clone(), |_| true).map_err(|e| e.to_string())?;
    let after = model.evaluate(dataset, |_| true).map_err(|e| e.to_string())?;
    let mut result = json!({"weights":weights,"samples":eligible,"before":{"logLoss":before.log_loss,"rmseBins":before.rmse_bins},"after":{"logLoss":after.log_loss,"rmseBins":after.rmse_bins}});
    if input.health {
      emit(json!({"progress":0.8,"message":"正在按时间分段检查"}));
      match fsrs::evaluate_with_time_series_splits(train, |_| true) {
        Ok(v) => result["health"] = json!({"logLoss":v.log_loss,"rmseBins":v.rmse_bins}),
        Err(e) => result["healthError"] = json!(e.to_string()),
      }
    }
    return Ok(result);
  }
  let missing_time = input.logs.iter().filter(|l| l.duration == 0).count();
  let logs: Vec<RevlogEntry> = input.logs.iter().map(|l| RevlogEntry { id:l.id, cid:l.cid, button_chosen:l.rating, interval:l.interval, last_interval:l.last_interval, taken_millis:l.duration, review_kind:match l.kind { 1=>RevlogReviewKind::Review,2=>RevlogReviewKind::Relearning,_=>RevlogReviewKind::Learning }, ..Default::default() }).collect();
  let mut config = if logs.is_empty() { SimulatorConfig::default() } else { fsrs::extract_simulator_config(logs, input.cutoff, true) };
  config.deck_size = input.deck_size.max(1); config.learn_span = 365;
  config.learn_limit = input.new_limit; config.review_limit = input.review_limit;
  config.max_ivl = input.maximum_interval; config.new_cards_ignore_review_limit = input.new_ignore_review;
  config.learning_step_count = input.learning_steps; config.relearning_step_count = input.relearning_steps;
  config.max_cost_perday = f32::MAX;
  if config.learn_limit == 0 || config.review_limit == 0 { return Err("每日额度为 0 时无法估算长期学习负担。请先调整预设草稿。".into()); }
  emit(json!({"progress":0.15,"message":"正在模拟不同记忆率的复习负担"}));
  let mut rows = Vec::new();
  for (idx, retention) in [0.7f32,0.75,0.8,0.85,0.9,0.95,0.99].into_iter().enumerate() {
    let simulation = fsrs::simulate(&config, &input.weights, retention, Some(20260903), None).map_err(|e| e.to_string())?;
    rows.push(json!({"retention":retention,"minutesPerDay":simulation.cost_per_day.iter().sum::<f32>()/365.0/60.0,"reviewsPerDay":simulation.review_cnt_per_day.iter().sum::<usize>() as f32/365.0,"remembered":simulation.memorized_cnt_per_day.last()}));
    emit(json!({"progress":0.2+idx as f32*0.08,"message":"正在比较记忆率"}));
  }
  let recommended = fsrs::optimal_retention(&config, &input.weights, |_| true, None, None).map_err(|e| e.to_string())?;
  Ok(json!({"rows":rows,"recommended":recommended,"samples":eligible,"missingTime":missing_time,"deckSize":config.deck_size}))
}
fn main() {
  let mut raw = String::new();
  if let Err(e) = std::io::stdin().read_to_string(&mut raw) { emit(json!({"error":e.to_string()})); return; }
  let result = serde_json::from_str::<Input>(&raw).map_err(|e| e.to_string()).and_then(run);
  match result { Ok(result) => emit(json!({"result":result})), Err(error) => emit(json!({"error":error})) }
}
